const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const https = require('https');
const dbHelper = require('./db');

global.mtgjsonSyncStatus = {
  status: 'idle', // 'idle', 'downloading', 'unzipping', 'success', 'error'
  progress: 0,
  message: 'System ready.',
  error: null
};

async function downloadAndUnzipMTGJSON() {
  if (global.mtgjsonSyncStatus.status === 'downloading' || global.mtgjsonSyncStatus.status === 'unzipping') {
    throw new Error("A database sync task is already in progress.");
  }

  global.mtgjsonSyncStatus.status = 'downloading';
  global.mtgjsonSyncStatus.progress = 0;
  global.mtgjsonSyncStatus.message = 'Connecting to MTGJSON server...';
  global.mtgjsonSyncStatus.error = null;

  const dataDir = fs.existsSync('/data') ? '/data' : __dirname;
  const zipPath = path.join(dataDir, 'AllPrintings.sqlite.zip');
  const dbPath = path.join(dataDir, 'AllPrintings.sqlite');

  const file = fs.createWriteStream(zipPath);

  return new Promise((resolve, reject) => {
    https.get('https://mtgjson.com/api/v5/AllPrintings.sqlite.zip', {
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        const err = new Error(`HTTP Error ${res.statusCode} from MTGJSON server`);
        global.mtgjsonSyncStatus.status = 'error';
        global.mtgjsonSyncStatus.message = err.message;
        global.mtgjsonSyncStatus.error = err.message;
        reject(err);
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          global.mtgjsonSyncStatus.progress = Math.round((downloadedBytes / totalBytes) * 100);
          global.mtgjsonSyncStatus.message = `Downloading database: ${global.mtgjsonSyncStatus.progress}% (${(downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(totalBytes / 1024 / 1024).toFixed(1)}MB)`;
        } else {
          global.mtgjsonSyncStatus.message = `Downloading database: ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB downloaded`;
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close();
        global.mtgjsonSyncStatus.status = 'unzipping';
        global.mtgjsonSyncStatus.progress = 100;
        global.mtgjsonSyncStatus.message = 'Extracting database file (this may take up to a minute)...';

        // Extract native command
        const cmd = process.platform === 'win32'
          ? `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${dataDir}' -Force"`
          : `unzip -o "${zipPath}" -d "${dataDir}"`;

        exec(cmd, async (err, stdout, stderr) => {
          // Cleanup zip file immediately to free disk space
          try { fs.unlinkSync(zipPath); } catch (e) {}

          if (err) {
            console.error("Extraction error:", err);
            const errStr = stderr || err.message;
            global.mtgjsonSyncStatus.status = 'error';
            global.mtgjsonSyncStatus.message = `Extraction failed: ${errStr}`;
            global.mtgjsonSyncStatus.error = errStr;
            reject(err);
          } else {
            console.log("Unzipped MTGJSON database successfully.");
            global.mtgjsonSyncStatus.message = 'Database extracted. Reconnecting database...';

            try {
              // Attempt to attach the database to the live pool
              await dbHelper.run(`ATTACH DATABASE ? AS mtgjson`, [dbPath]);
              global.mtgjsonSyncStatus.status = 'success';
              global.mtgjsonSyncStatus.message = 'MTGJSON database successfully synced and active!';
              resolve();
            } catch (attachErr) {
              // If already attached, SQLite will throw but it's safe to ignore
              if (attachErr.message.includes('already in use') || attachErr.message.includes('already attached')) {
                global.mtgjsonSyncStatus.status = 'success';
                global.mtgjsonSyncStatus.message = 'MTGJSON database successfully synced and active!';
                resolve();
              } else {
                console.error("Attach error:", attachErr);
                global.mtgjsonSyncStatus.status = 'error';
                global.mtgjsonSyncStatus.message = `Database attached check failed: ${attachErr.message}`;
                global.mtgjsonSyncStatus.error = attachErr.message;
                reject(attachErr);
              }
            }
          }
        });
      });
    }).on('error', (err) => {
      global.mtgjsonSyncStatus.status = 'error';
      global.mtgjsonSyncStatus.message = `Download failed: ${err.message}`;
      global.mtgjsonSyncStatus.error = err.message;
      reject(err);
    });
  });
}

module.exports = {
  downloadAndUnzipMTGJSON
};
