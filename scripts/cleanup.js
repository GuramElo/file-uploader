// scripts/cleanup.js
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_AGE_DAYS = 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

async function cleanupOldFiles() {
  try {
    console.log(`\n🧹 Cleaning up files older than ${MAX_AGE_DAYS} days...\n`);

    const files = await fs.readdir(UPLOAD_DIR);
    const now = Date.now();
    let deletedCount = 0;
    let freedSpace = 0;

    for (const file of files) {
      if (file === '.gitkeep') continue;

      const filePath = path.join(UPLOAD_DIR, file);
      const stats = await fs.stat(filePath);

      if (stats.isFile()) {
        const age = now - stats.mtimeMs;

        if (age > MAX_AGE_MS) {
          const size = stats.size;
          await fs.unlink(filePath);
          deletedCount++;
          freedSpace += size;
          console.log(`✅ Deleted: ${file} (${(size / 1024 / 1024).toFixed(2)}MB)`);
        }
      }
    }

    console.log(`\n📊 Cleanup Summary:`);
    console.log(`   Files deleted: ${deletedCount}`);
    console.log(`   Space freed: ${(freedSpace / 1024 / 1024 / 1024).toFixed(2)}GB\n`);

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  }
}

cleanupOldFiles();
