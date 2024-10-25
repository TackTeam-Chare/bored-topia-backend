// Load environment variables from the .env file
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise'); // Use promise-based MySQL
const bodyParser = require('body-parser');
const cors = require('cors');

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Configure CORS with specific allowed origin
const allowedOrigins = [
    'https://bored-topia-demo-game.vercel.app',
    'http://localhost:5173'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true); // Allow the origin
        } else {
            callback(new Error('Not allowed by CORS')); // Block other origins
        }
    },
    methods: ['GET', 'POST'], // Allowed methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
    credentials: true, // Allow cookies if needed
};

// ใช้ middleware CORS
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // จัดการ preflight requests

app.use(bodyParser.json());

// Create MySQL pool to manage connections efficiently
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10, // Maximum number of connections
    queueLimit: 0
});

// Test MySQL connection
pool.getConnection()
    .then(connection => {
        console.log('Connected to MySQL');
        connection.release(); // Release the connection back to the pool
    })
    .catch(err => {
        console.error('Error connecting to MySQL:', err);
    });

app.post('/assign-room', async (req, res) => {
    const { userAddress } = req.body;

    try {
        const connection = await pool.getConnection();

        // ตรวจสอบว่าผู้ใช้มีห้องอยู่แล้วหรือไม่
        const [existingRoom] = await connection.execute(
            'SELECT room_id FROM players_in_room WHERE userAddress = ?',
            [userAddress]
        );

        if (existingRoom.length > 0) {
            connection.release();
            return res.status(200).json({
                message: 'This address is already assigned to a room.',
                roomId: existingRoom[0].room_id
            });
        }

        // ค้นหาห้องที่มีที่ว่างและยังไม่เต็ม (ไม่เกิน 48 คน)
        const [availableRoom] = await connection.execute(
            `SELECT r.id, COUNT(pir.userAddress) AS player_count 
             FROM rooms r 
             LEFT JOIN players_in_room pir ON r.id = pir.room_id 
             WHERE r.status = "available" 
             GROUP BY r.id 
             HAVING player_count < 48 
             LIMIT 1`
        );

        let roomId;

        // ถ้าไม่มีห้องว่าง สร้างห้องใหม่
        if (availableRoom.length === 0) {
            const [result] = await connection.execute(
                `INSERT INTO rooms (room_name, status) VALUES (?, 'available')`,
                [`Room ${Date.now()}`]  // ใช้ timestamp เพื่อสร้างชื่อห้องที่ไม่ซ้ำกัน
            );
            roomId = result.insertId; // เก็บ roomId ของห้องใหม่ที่เพิ่งสร้าง
            console.log(`New room created: Room ID ${roomId}`);
        } else {
            roomId = availableRoom[0].id; // ใช้ห้องที่มีอยู่แล้ว
        }

        // เพิ่มผู้เล่นใหม่ในห้อง
        await connection.execute(
            'INSERT INTO players_in_room (userAddress, room_id) VALUES (?, ?)',
            [userAddress, roomId]
        );

        connection.release();
        res.status(200).json({ roomId });
    } catch (error) {
        console.error('Error assigning room:', error);
        res.status(500).json({ error: 'Error assigning room.' });
    }
});

// Endpoint to submit a score
// Endpoint to submit a score
app.post('/submit-score', async (req, res) => {
    const { userAddress, score, tokenBalance } = req.body;

    // ตรวจสอบความถูกต้องของข้อมูล
    if (!userAddress) {
        return res.status(400).json({ error: 'User address is required.' });
    }
    if (isNaN(score) || score < 0) {
        return res.status(400).json({ error: 'Score must be a non-negative number.' });
    }

    try {
        const connection = await pool.getConnection();

        const query = `
            INSERT INTO players (userAddress, score, tokenBalance, gamesPlayed, timestamp)
            VALUES (?, ?, ?, 1, NOW())
            ON DUPLICATE KEY UPDATE
                score = GREATEST(score, VALUES(score)),
                tokenBalance = VALUES(tokenBalance),
                gamesPlayed = gamesPlayed + 1,
                timestamp = NOW()
        `;

        // บันทึกคะแนน
        await connection.execute(query, [
            userAddress,
            score || 0,
            tokenBalance ?? 0 // ใช้ค่า default 0 ถ้าไม่มี tokenBalance
        ]);

        // ตรวจสอบว่าผู้เล่นนี้มี invite code อยู่หรือไม่
        const [invite] = await connection.execute(
            'SELECT * FROM invitations WHERE inviteeAddress = ? AND bonusApplied = FALSE',
            [userAddress]
        );

        if (invite.length > 0) {
            const inviterAddress = invite[0].inviterAddress;

            // เรียก apply-bonus เพื่อให้โบนัสทั้ง inviter และ invitee
            const bonus = Math.floor(score * 0.5);
            await connection.execute(
                'UPDATE players SET score = score + ?, bonusReceived = TRUE WHERE userAddress = ?',
                [bonus, inviterAddress]
            );
            await connection.execute(
                'UPDATE players SET score = score + ?, bonusReceived = TRUE WHERE userAddress = ?',
                [bonus, userAddress]
            );

            // ทำเครื่องหมายว่าโบนัสถูกใช้แล้ว
            await connection.execute(
                'UPDATE invitations SET bonusApplied = TRUE WHERE inviteeAddress = ?',
                [userAddress]
            );

            console.log(`Bonus applied for inviter: ${inviterAddress} and invitee: ${userAddress}`);
        }

        connection.release();
        res.status(200).json({ message: 'Score submitted and bonus applied if applicable.' });
    } catch (err) {
        console.error('Error submitting score:', err);
        res.status(500).json({ error: 'Error submitting score.' });
    }
});



// ดึงข้อมูล Leaderboard พร้อมคำนวณโบนัส
app.get('/leaderboard/:roomId', async (req, res) => {
    const { roomId } = req.params;

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(
            `SELECT p.userAddress, p.score
             FROM players p
             JOIN players_in_room pir ON p.userAddress = pir.userAddress
             WHERE pir.room_id = ?
             ORDER BY p.score DESC LIMIT 11`,
            [roomId]
        );

        if (results.length < 6) {
            // ถ้ามีผู้เล่นน้อยกว่า 6 คน ให้ส่งข้อมูลตามปกติ
            connection.release();
            return res.json(results);
        }

        // คำนวณโบนัสจากคะแนนของผู้เล่นอันดับ 6
        const sixthPlayerScore = results[5].score;
        const bonus = Math.floor(sixthPlayerScore / 10);

        // แจกโบนัสให้กับผู้เล่นคนอื่น (ยกเว้นคนที่ได้อันดับ 6)
        const updatedResults = results.map((player, index) => {
            if (index !== 5) {
                player.score += bonus; // เพิ่มโบนัสให้ผู้เล่นอื่น
            }
            return player;
        });

        connection.release();
        res.json(updatedResults); // ส่งข้อมูลที่อัปเดตกลับไป
    } catch (err) {
        console.error('Error retrieving leaderboard:', err);
        res.status(500).send('Error retrieving leaderboard.');
    }
});


// Endpoint to get the top players for a specific room in Hall of Fame
app.get('/hall-of-fame/:roomId', async (req, res) => {
    const { roomId } = req.params;

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(
            `SELECT p.userAddress, p.score 
             FROM players p
             JOIN players_in_room pir ON p.userAddress = pir.userAddress
             WHERE pir.room_id = ?
             ORDER BY p.score DESC LIMIT 48`, 
             [roomId]
        );

        connection.release();
        res.json(results);
    } catch (err) {
        console.error('Error retrieving Hall of Fame:', err);
        res.status(500).send('Error retrieving Hall of Fame.');
    }
});

app.get('/player-stats/:userAddress', async (req, res) => {
    const { userAddress } = req.params;

    try {
        const connection = await pool.getConnection();

        const [rows] = await connection.execute(
            `SELECT score, gamesPlayed FROM players WHERE userAddress = ?`,
            [userAddress]
        );

        connection.release();

        if (rows.length > 0) {
            res.json({
                userAddress,
                score: rows[0].score,
                gamesPlayed: rows[0].gamesPlayed
            });
        } else {
            res.status(404).json({ error: 'Player not found.' });
        }
    } catch (error) {
        console.error('Error retrieving player stats:', error);
        res.status(500).json({ error: 'Error retrieving player stats.' });
    }
});

app.post('/check-user', async (req, res) => {
    const { userAddress } = req.body;

    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.query(
            'SELECT COUNT(*) AS count FROM players WHERE userAddress = ?',
            [userAddress]
        );
        connection.release();

        const isNewUser = rows[0].count === 0;
        res.json({ isNewUser });
    } catch (error) {
        console.error('Error checking user:', error);
        res.status(500).json({ error: 'Error checking user.' });
    }
});

app.post('/submit-invite', async (req, res) => {
    const { code } = req.body;

    // Log เพื่อตรวจสอบว่าข้อมูลได้รับถูกต้อง
    console.log(`Received invite code: ${code}`);

    if (!code) {
        console.error('No invite code provided.');
        return res.status(400).json({ error: 'Invite code is required.' });
    }

    try {
        const connection = await pool.getConnection();

        // ตรวจสอบว่ามี inviteeAddress นี้อยู่แล้วหรือไม่
        const [existing] = await connection.query(
            'SELECT * FROM invitations WHERE inviteeAddress = ?',
            [code]
        );

        if (existing.length > 0) {
            console.warn(`Invite code ${code} already used.`);
            connection.release();
            return res.status(400).json({ error: 'This invite code has already been used.' });
        }

        // บันทึกการเชิญใหม่
        console.log(`Recording new invitation with code: ${code}`);
        await connection.execute(
            'INSERT INTO invitations (inviterAddress, inviteeAddress) VALUES (?, ?)',
            ['sample-inviter-address', code]
        );

        connection.release();
        res.status(200).json({ message: 'Invitation recorded successfully.' });
    } catch (error) {
        console.error('Error submitting invite code:', error); // Log ข้อผิดพลาด
        res.status(500).json({ error: 'Error recording invitation.' });
    }
});


app.post('/apply-bonus', async (req, res) => {
    const { inviteeAddress, score } = req.body;

    // ตรวจสอบความถูกต้องของข้อมูลที่ได้รับ
    if (!inviteeAddress || !score) {
        console.error('Invitee address or score is missing.');
        return res.status(400).json({ error: 'Invitee address and score are required.' });
    }

    try {
        const connection = await pool.getConnection();

        // ตรวจสอบว่ามีการเชิญอยู่และโบนัสยังไม่ได้ใช้
        const [invite] = await connection.execute(
            'SELECT * FROM invitations WHERE inviteeAddress = ? AND bonusApplied = FALSE',
            [inviteeAddress]
        );

        if (invite.length === 0) {
            console.warn('No valid invitation found or bonus already applied.');
            connection.release();
            return res.status(400).json({ error: 'No valid invitation found or bonus already applied.' });
        }

        const inviterAddress = invite[0].inviterAddress;
        const bonus = Math.floor(score * 0.5); // คำนวณโบนัส 50%

        // เพิ่มคะแนนให้ผู้เชิญ
        await connection.execute(
            'UPDATE players SET score = score + ?, bonusReceived = TRUE WHERE userAddress = ?',
            [bonus, inviterAddress]
        );

        // เพิ่มคะแนนให้ผู้ถูกเชิญ
        await connection.execute(
            'UPDATE players SET score = score + ?, bonusReceived = TRUE WHERE userAddress = ?',
            [bonus, inviteeAddress]
        );

        // ทำเครื่องหมายว่าโบนัสถูกใช้แล้ว
        await connection.execute(
            'UPDATE invitations SET bonusApplied = TRUE WHERE inviteeAddress = ?',
            [inviteeAddress]
        );

        connection.release();
        res.status(200).json({ message: 'Bonus applied successfully.' });
    } catch (error) {
        console.error('Error applying bonus:', error);
        res.status(500).json({ error: 'Error applying bonus.' });
    }
});


// Endpoint เพื่อดึงจำนวนเพื่อนที่ผู้ใช้เชิญ
app.get('/invites-count/:userAddress', async (req, res) => {
    const { userAddress } = req.params;

    try {
        const connection = await pool.getConnection();

        const [rows] = await connection.query(
            'SELECT COUNT(*) AS inviteCount FROM invitations WHERE inviterAddress = ?',
            [userAddress]
        );

        connection.release();

        res.json({ inviteCount: rows[0].inviteCount });
    } catch (error) {
        console.error('Error retrieving invite count:', error);
        res.status(500).json({ error: 'Error retrieving invite count.' });
    }
});


// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
