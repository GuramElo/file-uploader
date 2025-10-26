import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';
import http from 'http';
import rateLimit from 'express-rate-limit';
import checkDiskSpace from 'check-disk-space';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Logger Setup ---
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }),
    ],
});

// --- Configuration ---
const config = {
    host: process.env.HOST || '0.0.0.0',
    port: parseInt(process.env.PORT || '3000', 10),
    uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'),
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10737418240', 10),
    minFreeSpace: parseInt(process.env.MIN_FREE_SPACE || '5368709120', 10),
    chunkSize: parseInt(process.env.CHUNK_SIZE || '5242880', 10),
    allowedExtensions: process.env.ALLOWED_EXTENSIONS === '*' ? null : process.env.ALLOWED_EXTENSIONS?.split(',').filter(Boolean) || null,
    corsOrigin: process.env.CORS_ORIGIN || '*',
    uploadTimeout: parseInt(process.env.UPLOAD_TIMEOUT || '3600000', 10),
};

logger.info('Configuration loaded:', {
    allowedExtensions: config.allowedExtensions || 'All file types allowed',
    maxFileSize: `${(config.maxFileSize / 1024 / 1024 / 1024).toFixed(2)}GB`,
    uploadDir: config.uploadDir,
});

// --- Ensure directories exist ---
async function ensureUploadDir() {
    try {
        await fsPromises.access(config.uploadDir);
        logger.info(`Upload directory exists: ${config.uploadDir}`);
    } catch {
        await fsPromises.mkdir(config.uploadDir, { recursive: true });
        logger.info(`Created upload directory: ${config.uploadDir}`);
    }

    // Test write permissions
    try {
        const testFile = path.join(config.uploadDir, '.write-test');
        await fsPromises.writeFile(testFile, 'test');
        await fsPromises.unlink(testFile);
        logger.info('✅ Upload directory is writable');
    } catch (error) {
        logger.error('❌ Upload directory is NOT writable:', error);
        throw error;
    }
}

async function ensureLogsDir() {
    const logsDir = path.join(__dirname, 'logs');
    try {
        await fsPromises.access(logsDir);
    } catch {
        await fsPromises.mkdir(logsDir, { recursive: true });
        logger.info(`Created logs directory: ${logsDir}`);
    }
}

// --- Check disk space ---
async function checkAvailableSpace() {
    try {
        const diskSpace = await checkDiskSpace(config.uploadDir);
        const freeSpace = diskSpace.free;

        logger.debug(`Disk space: ${(freeSpace / 1024 / 1024 / 1024).toFixed(2)}GB free`);

        if (freeSpace < config.minFreeSpace) {
            logger.error(`Low disk space: ${(freeSpace / 1024 / 1024 / 1024).toFixed(2)}GB free`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error('Error checking disk space:', error);
        return false;
    }
}

// --- Sanitize Filename ---
function sanitizeFilename(filename) {
    if (!filename) return 'unnamed_file';
    return filename.replace(/[\/\\?%*:|"<>]/g, '-').replace(/\.\./g, '-').trim().substring(0, 255);
}

// --- Helper: Cleanup failed upload ---
async function cleanupUpload(uploadId) {
    const filePath = path.join(config.uploadDir, uploadId);
    const metadataPath = filePath + '.json';
    try {
        await Promise.allSettled([
            fsPromises.unlink(filePath).catch(() => {}),
            fsPromises.unlink(metadataPath).catch(() => {}),
        ]);
        logger.info(`Cleaned up upload: ${uploadId}`);
    } catch (error) {
        logger.error(`Error cleaning up upload ${uploadId}:`, error);
    }
}

// --- Express App Setup ---
const app = express();
app.set('trust proxy', 1);

app.use(cors({
    origin: '*', // Allow all origins
    methods: ['GET', 'POST', 'PATCH', 'HEAD', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['*'],
    exposedHeaders: ['*'],
    credentials: false
}));

// --- Relaxed Helmet (allow Uppy CDN) ---
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false // disable CSP so CDN assets aren't blocked
}));

// --- Rate Limiting ---
const uploadCreationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    skip: (req) => req.method !== 'POST',
});

// --- Request Timeout ---
app.use((req, res, next) => {
    req.setTimeout(config.uploadTimeout);
    res.setTimeout(config.uploadTimeout);
    next();
});

// --- Health Check ---
app.get('/health', async (req, res) => {
    try {
        // Quick OK response without delaying front-end
        const diskSpace = await checkDiskSpace(config.uploadDir);
        const hasSpace = diskSpace.free >= config.minFreeSpace;

        res.status(hasSpace ? 200 : 503).json({
            status: hasSpace ? 'healthy' : 'degraded',
            timestamp: new Date(),
            uptime: process.uptime(),
            disk: {
                free: `${(diskSpace.free / 1024 / 1024 / 1024).toFixed(2)}GB`,
                total: `${(diskSpace.size / 1024 / 1024 / 1024).toFixed(2)}GB`,
                used: `${((diskSpace.size - diskSpace.free) / 1024 / 1024 / 1024).toFixed(2)}GB`,
            },
            memory: {
                used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`,
                total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)}MB`,
            }
        });
    } catch (error) {
        logger.error('Health check failed:', error);
        res.status(503).json({ status: 'error', error: error.message });
    }
});

// --- Tus Server Setup ---
let tusServer;
try {
    tusServer = new Server({
        path: '/files',
        datastore: new FileStore({ directory: config.uploadDir }),
        maxSize: config.maxFileSize,
        // Fix: Delay rename so final HEAD request succeeds
        onUploadFinish: async (req, res, upload) => {
            const uploadId = upload.id;
            logger.info(`✅ Upload finished: ${uploadId}`);

            setTimeout(async () => {
                try {
                    const metaData = upload?.metadata || {};
                    const fileName = metaData?.filename
                        ? sanitizeFilename(metaData.filename)
                        : 'unnamed_file';

                    const extension = path.extname(fileName);
                    const baseName = path.basename(fileName, extension);
                    const hashedFileName = uploadId;
                    const newFileName = extension
                        ? `${baseName}--${hashedFileName}${extension}`
                        : `${baseName}--${hashedFileName}`;

                    const oldFilePath = path.join(config.uploadDir, hashedFileName);
                    const newFilePath = path.join(config.uploadDir, newFileName);
                    const metadataPath = oldFilePath + '.json';

                    const stats = await fsPromises.stat(oldFilePath);
                    logger.info(`Upload size: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

                    await fsPromises.rename(oldFilePath, newFilePath);
                    await fsPromises.unlink(metadataPath).catch(() => {});
                    logger.info(`✅ File renamed to: ${newFileName}`);
                } catch (error) {
                    logger.error(`Error in rename for ${uploadId}:`, error);
                    await cleanupUpload(uploadId);
                }
            }, 500);
        },
    });
} catch (error) {
    logger.error('❌ Failed to create TUS Server:', error);
    process.exit(1);
}

// --- Tus Events ---
tusServer.on(EVENTS.POST_CREATE, (req, res, upload) => {
    logger.info(`📝 Upload created: ${upload.id}`);
});
tusServer.on(EVENTS.POST_RECEIVE, (req, res, upload) => {
    const progress = ((upload.offset / upload.size) * 100).toFixed(2);
    logger.debug(`📊 Progress [${upload.id}]: ${progress}%`);
});

// --- Wrap TUS handler ---
const tusHandler = async (req, res) => {
    try {
        await tusServer.handle(req, res);
    } catch (error) {
        logger.error(`❌ TUS Handler Error: ${error.message}`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Upload error', message: error.message });
        }
    }
};

// --- File upload route ---
const uploadApp = express();
uploadApp.use(uploadCreationLimiter);
uploadApp.all('*', tusHandler);
app.use('/files', uploadApp);

// --- Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start Server ---
let server;
async function startServer() {
    await ensureLogsDir();
    await ensureUploadDir();
    server = http.createServer(app).listen(config.port, config.host, () => {
        logger.info(`🚀 Server running at http://${config.host}:${config.port}`);
    });
}
startServer();