const express = require('express');
const { spawn, execFile } = require('node:child_process');
const util = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const execFilePromise = util.promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

// Nhận diện môi trường hệ điều hành
const isWindows = process.platform === 'win32';

// Trên Vercel/Linux, bắt buộc lưu file tạm vào /tmp để tránh lỗi Read-only File System
const binDir = isWindows ? process.cwd() : '/tmp';
const ytDlpFileName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const ytDlpPath = path.join(binDir, ytDlpFileName);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Hàm hỗ trợ tải file có xử lý chuyển hướng URL
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return resolve(downloadFile(response.headers.location, destPath));
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`Tải tệp thất bại, mã HTTP: ${response.statusCode}`));
            }
            const fileStream = fs.createWriteStream(destPath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => reject(err));
        });
    });
}

// Hàm đảm bảo công cụ yt-dlp luôn sẵn sàng
async function ensureYtDlp() {
    if (fs.existsSync(ytDlpPath)) {
        return;
    }

    console.log(`Đang tải ${ytDlpFileName} về thư mục ${binDir}...`);
    const downloadUrl = isWindows
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    try {
        await downloadFile(downloadUrl, ytDlpPath);
        if (!isWindows) {
            fs.chmodSync(ytDlpPath, 0o755); // Cấp quyền thực thi trên môi trường Linux của Vercel
        }
        console.log(`Đã chuẩn bị xong ${ytDlpFileName}!`);
    } catch (error) {
        console.error(`Không thể chuẩn bị ${ytDlpFileName}:`, error.message);
    }
}

// 1. API lấy thông tin video
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu đường link video!' });

    try {
        await ensureYtDlp();

        const args = ['--dump-single-json', '--no-warnings', url];
        const { stdout } = await execFilePromise(ytDlpPath, args, {
            maxBuffer: 1024 * 1024 * 30
        });

        const data = JSON.parse(stdout);
        return res.json({
            title: data.title,
            thumbnail: data.thumbnail,
            uploader: data.uploader,
            duration: data.duration
        });
    } catch (err) {
        console.error('Lỗi khi phân tích video:', err);
        return res.status(500).json({ error: 'Không thể phân tích video này.' });
    }
});

// 2. API truyền luồng tải dữ liệu
app.get('/api/download', async (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).send('Thiếu đường link URL');

    try {
        await ensureYtDlp();

        const isMp3 = format === 'mp3';
        if (isMp3) {
            res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
            res.setHeader('Content-Type', 'audio/mpeg');
        } else {
            res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
            res.setHeader('Content-Type', 'video/mp4');
        }

        let args = [];
        if (isMp3) {
            args = ['-x', '--audio-format', 'mp3', '-o', '-', url];
        } else {
            args = ['-f', 'best[ext=mp4]/best', '-o', '-', url];
        }

        const ytdlProcess = spawn(ytDlpPath, args);
        ytdlProcess.stdout.pipe(res);

        req.on('close', () => {
            ytdlProcess.kill();
        });
    } catch (err) {
        console.error('Lỗi khi xử lý tải tệp:', err);
        res.status(500).send('Lỗi máy chủ khi tải tệp');
    }
});

// Khởi chạy máy chủ cục bộ (Vercel sẽ tự export app qua serverless)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Website đang chạy tại: http://localhost:${PORT}`);
    });
}

module.exports = app;