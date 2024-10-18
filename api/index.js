// Load environment variables from the .env file

const config = require('../config');
const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// สร้างการเชื่อมต่อ MySQL โดยใช้ตัวแปรจาก config.js
const db = mysql.createConnection({
    host: config.DB_HOST,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    port: config.DB_PORT
});

// ทดสอบการเชื่อมต่อ
db.connect(err => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL');
});

// Endpoint to submit score
app.post('/submit-score', (req, res) => {
    let { userAddress, score, tokenBalance } = req.body;

    if (!userAddress) {
        return res.status(400).send('User address is required.');
    }

    score = score !== undefined ? score : null;
    tokenBalance = tokenBalance !== undefined ? tokenBalance : null;

    const query = `
        INSERT INTO players (userAddress, score, tokenBalance)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            score = GREATEST(score, VALUES(score)),
            tokenBalance = VALUES(tokenBalance)
    `;

    db.execute(
        query,
        [userAddress, score, tokenBalance],
        (err, results) => {
            if (err) {
                console.error('Error submitting score:', err);
                return res.status(500).send('Error submitting score.');
            }
            res.send('Score submitted successfully.');
        }
    );
});

// Endpoint to get the top 11 players for the Leaderboard
app.get('/leaderboard', (req, res) => {
    const query = 'SELECT userAddress, score FROM players ORDER BY score DESC LIMIT 11';

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error retrieving leaderboard:', err);
            return res.status(500).send('Error retrieving leaderboard.');
        }
        res.json(results);
    });
});

// Endpoint to get the top 48 players for the Hall of Fame
app.get('/hall-of-fame', (req, res) => {
    const query = 'SELECT userAddress, score FROM players ORDER BY score DESC LIMIT 48';
    
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error retrieving Hall of Fame:', err);
            return res.status(500).send('Error retrieving Hall of Fame');
        }
        res.json(results);
    });
});

// เพิ่ม API เพื่อดึงข้อมูลของผู้เล่นจาก wallet address
app.post('/get-player-score', (req, res) => {
    const { userAddress } = req.body;

    if (!userAddress) {
        return res.status(400).send('User address is required.');
    }

    const query = `SELECT userAddress, score FROM players WHERE userAddress = ?`;

    db.query(query, [userAddress], (err, results) => {
        if (err) {
            console.error('Error retrieving player score:', err);
            return res.status(500).send('Error retrieving player score.');
        }

        if (results.length > 0) {
            res.json(results[0]); // ส่งผลลัพธ์เป็น json ของผู้เล่นที่ตรงกับ userAddress
        } else {
            res.status(404).send('Player not found.');
        }
    });
});

// Start server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
