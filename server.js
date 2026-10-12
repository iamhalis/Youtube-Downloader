const express = require('express');
const { spawn, execFile } = require('node:child_process');
const util = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const execFilePromise = util.promisify(execFile);
const app = express();
const PORT = 3000;

const botRoot = process.cwd();
const isWindows = process.platform === 'win32';
const ytDlpFileName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const ytDlpPath = path.join(botRoot, ytDlpFileName);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Hàm tự động tải file từ URL (hỗ trợ chuyển hướng redirect)
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return resolve(downloadFile(response.headers.location, destPath));
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`Tải tệp thất bại với mã trạng thái: ${response.statusCode}`));
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
        console.log(`✅ Đã tìm thấy công cụ: ${ytDlpFileName}`);
        return;
    }

    console.log(`⚠️ Chưa có ${ytDlpFileName}. Đang tự động tải về từ GitHub Releases...`);
    const downloadUrl = isWindows
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    try {
        await downloadFile(downloadUrl, ytDlpPath);
        if (!isWindows) {
            fs.chmodSync(ytDlpPath, 0o755); // Cấp quyền thực thi trên môi trường Linux
        }
        console.log(`🎉 Tải ${ytDlpFileName} thành công!`);
    } catch (error) {
        console.error(`❌ Không thể tự động tải ${ytDlpFileName}:`, error.message);
    }
}

// 1. API lấy thông tin video YouTube
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu đường link video!' });

    if (!fs.existsSync(ytDlpPath)) {
        return res.status(500).json({ error: 'Công cụ yt-dlp đang được tải hoặc chưa sẵn sàng. Vui lòng thử lại sau 1 phút!' });
    }

    try {
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
        return res.status(500).json({ error: 'Không thể phân tích video này. Hãy thử liên kết khác!' });
    }
});

// 2. API truyền luồng tải dữ liệu (Hỗ trợ MP4 và MP3)
app.get('/api/download', (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).send('Thiếu đường link URL');

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
        args = [
            '-x',
            '--audio-format', 'mp3',
            '--ffmpeg-location', botRoot,
            '-o', '-',
            url
        ];
    } else {
        args = [
            '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
            '--ffmpeg-location', botRoot,
            '-o', '-',
            url
        ];
    }

    const ytdlProcess = spawn(ytDlpPath, args);
    ytdlProcess.stdout.pipe(res);

    ytdlProcess.on('close', (code) => {
        if (code !== 0) console.log(`yt-dlp kết thúc với mã: ${code}`);
    });

    req.on('close', () => {
        ytdlProcess.kill();
    });
});

// Khởi động server sau khi kiểm tra công cụ
app.listen(PORT, async () => {
    console.log(`🚀 Website đang chạy tại: http://localhost:${PORT}`);
    await ensureYtDlp();
});