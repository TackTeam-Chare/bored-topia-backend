// Load environment variables from the .env file
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise'); // Use promise-based MySQL
const bodyParser = require('body-parser');
const cors = require('cors');

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
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

// Helper function to initialize demo rooms (if needed)
async function initializeDemoRooms() {
    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.query('SELECT COUNT(*) AS count FROM rooms');
        if (rows[0].count === 0) {
            const insertQuery = `
                INSERT INTO rooms (room_name, status) VALUES
                ('Room 1', 'available'),
                ('Room 2', 'available'),
                ('Room 3', 'available'),
                ('Room 4', 'available'),
                ('Room 5', 'available')
            `;
            await connection.query(insertQuery);
            console.log('Demo rooms initialized.');
        } else {
            console.log('Rooms already exist.');
        }
        connection.release();
    } catch (err) {
        console.error('Error initializing demo rooms:', err);
    }
}

// Initialize rooms on startup
initializeDemoRooms();

app.post('/assign-room', async (req, res) => {
    const { userAddress } = req.body;

    try {
        const connection = await pool.getConnection();

        // Check if the user already has a room
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

        // Find an available room and assign it
        const [room] = await connection.execute(
            'SELECT id FROM rooms WHERE status = "available" LIMIT 1'
        );

        if (room.length === 0) {
            connection.release();
            return res.status(400).json({ error: 'No rooms available.' });
        }

        const roomId = room[0].id;

        await connection.execute(
            'UPDATE rooms SET status = "unavailable" WHERE id = ?',
            [roomId]
        );

        // Save the player in the assigned room
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
app.post('/submit-score', async (req, res) => {
    const { userAddress, score, tokenBalance } = req.body;

    if (!userAddress) {
        return res.status(400).send('User address is required.');
    }

    try {
        const connection = await pool.getConnection();

        const query = `
            INSERT INTO players (userAddress, score, tokenBalance, timestamp)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                score = GREATEST(score, VALUES(score)),
                tokenBalance = VALUES(tokenBalance),
                timestamp = NOW()
        `;

        await connection.execute(query, [userAddress, score || 0, tokenBalance || 0]);

        connection.release();
        res.send('Score submitted successfully.');
    } catch (err) {
        console.error('Error submitting score:', err);
        res.status(500).send('Error submitting score.');
    }
});

app.post('/get-room-id', async (req, res) => {
    const { userAddress } = req.body;

    if (!userAddress) {
        return res.status(400).json({ error: 'User address is required.' });
    }

    try {
        const connection = await pool.getConnection();
        const [result] = await connection.query(
            'SELECT room_id FROM players_in_room WHERE userAddress = ?',
            [userAddress]
        );
        connection.release();

        if (result.length > 0) {
            res.status(200).json({ roomId: result[0].room_id });
        } else {
            res.status(404).json({ error: 'Room not found.' });
        }
    } catch (error) {
        console.error('Error fetching room ID:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});


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

        connection.release();
        res.json(results);
    } catch (err) {
        console.error('Error retrieving leaderboard:', err);
        res.status(500).send('Error retrieving leaderboard.');
    }
});

// Endpoint to get the top 48 players for the Hall of Fame
app.get('/hall-of-fame', async (req, res) => {
    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(
            'SELECT userAddress, score FROM players ORDER BY score DESC LIMIT 48'
        );

        connection.release();
        res.json(results);
    } catch (err) {
        console.error('Error retrieving Hall of Fame:', err);
        res.status(500).send('Error retrieving Hall of Fame.');
    }
});

// Endpoint to get a player's score based on wallet address
app.post('/get-player-score', async (req, res) => {
    const { userAddress } = req.body;

    if (!userAddress) {
        return res.status(400).send('User address is required.');
    }

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(
            'SELECT userAddress, score FROM players WHERE userAddress = ?',
            [userAddress]
        );

        connection.release();
        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.status(404).send('Player not found.');
        }
    } catch (err) {
        console.error('Error retrieving player score:', err);
        res.status(500).send('Error retrieving player score.');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
