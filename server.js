const express = require('express');
const { spawn, execFile } = require('node:child_process');
const util = require('node:util');
const path = require('node:path');
const fs = require('node:fs');

const execFilePromise = util.promisify(execFile);
const app = express();
const PORT = 3000;

// Cấu hình đường dẫn tệp công cụ
const botRoot = process.cwd();
const ytDlpPath = fs.existsSync(path.join(botRoot, 'yt-dlp.exe')) 
    ? path.join(botRoot, 'yt-dlp.exe') 
    : 'yt-dlp';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. API lấy thông tin tóm tắt của video
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu đường link video!' });

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

    // Cấu hình Header phản hồi phù hợp với từng định dạng
    if (isMp3) {
        res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
        res.setHeader('Content-Type', 'audio/mpeg');
    } else {
        res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
        res.setHeader('Content-Type', 'video/mp4');
    }

    // Thiết lập tham số dòng lệnh tương ứng
    let args = [];
    if (isMp3) {
        // Trích xuất âm thanh và ép kiểu về MP3 bằng ffmpeg
        args = [
            '-x',
            '--audio-format', 'mp3',
            '--ffmpeg-location', botRoot,
            '-o', '-',
            url
        ];
    } else {
        // Tải video chuẩn 720p
        args = [
            '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
            '--ffmpeg-location', botRoot,
            '-o', '-',
            url
        ];
    }

    // Khởi chạy tiến trình yt-dlp
    const ytdlProcess = spawn(ytDlpPath, args);

    // Truyền trực tiếp luồng dữ liệu (Stream) về trình duyệt
    ytdlProcess.stdout.pipe(res);

    ytdlProcess.stderr.on('data', (data) => {
        // In log tiến trình nếu cần kiểm tra lỗi
    });

    ytdlProcess.on('close', (code) => {
        if (code !== 0) console.log(`yt-dlp kết thúc với mã lỗi: ${code}`);
    });

    req.on('close', () => {
        // Ngắt tiến trình nếu người dùng bấm hủy tải trên trình duyệt
        ytdlProcess.kill();
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Website đang chạy tại: http://localhost:${PORT}`);
});