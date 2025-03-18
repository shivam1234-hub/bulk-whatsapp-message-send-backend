const express = require("express");
const fileUpload = require("express-fileupload");
const {Client, RemoteAuth} = require("whatsapp-web.js");
const qrcode = require("qrcode");
const cors = require("cors");
const csvParser = require("csv-parser");
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const fs = require("fs");
const User = require('./User');

// Ensure the uploads directory exists
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, {recursive: true});
}

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Store active WhatsApp clients
const clients = new Map();
const qrCodes = new Map();

// MongoDB connection
mongoose.connect('mongodb+srv://Cluster77664:VEdiYm5VTVdh@cluster77664.91pia.mongodb.net/whatsapp-sessions', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    // Initialize WhatsApp client for a user
    async function initializeClient(userId) {
        const client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                clientId: userId,
                backupSyncIntervalMs: 300000
            })
        });

        client.on("qr", async (qr) => {
            qrCodes.set(userId, await qrcode.toDataURL(qr));
        });

        client.on("ready", async () => {
            clients.set(userId, client);
            await User.findOneAndUpdate(
                { userId },
                { isAuthenticated: true },
                { upsert: true }
            );
            console.log(`WhatsApp Web is ready for user ${userId}!`);
        });

        client.on("disconnected", async () => {
            await User.findOneAndUpdate(
                { userId },
                { isAuthenticated: false }
            );
            clients.delete(userId);
            qrCodes.delete(userId);
        });

        await client.initialize();
    }

    // Routes
    app.post("/init-session", async (req, res) => {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }
        await initializeClient(userId);
        res.json({ status: "Session initialization started" });
    });

    app.get("/qr/:userId", async (req, res) => {
        const { userId } = req.params;
        const user = await User.findOne({ userId });

        if (user && user.isAuthenticated) {
            return res.json({ status: "authenticated" });
        }

        const qr = qrCodes.get(userId);
        if (!qr) {
            return res.json({ status: "waiting_for_qr" });
        }

        res.json({ status: "not_authenticated", qr });
    });

    app.post("/upload/:userId", async (req, res) => {
        const { userId } = req.params;
        if (!req.files || !req.files.file) {
            return res.status(400).send("No file uploaded");
        }

        const file = req.files.file;
        const filePath = `./uploads/${userId}_${file.name}`;
        await file.mv(filePath);

        const phoneNumbers = new Set();
        fs.createReadStream(filePath)
            .pipe(csvParser())
            .on("data", (row) => {
                if (row["Phone Number"]) {
                    let phoneNumber = row["Phone Number"].replace(/\s+/g, "").trim();
                    phoneNumber = "91" + phoneNumber;
                    phoneNumbers.add(phoneNumber);
                }
            })
            .on("end", () => {
                // Delete the file after processing
                fs.unlinkSync(filePath);
                res.json({ contacts: [...phoneNumbers] });
            })
            .on("error", (error) => res.status(500).send(error.message));
    });

    app.post("/send/:userId", async (req, res) => {
        const { userId } = req.params;
        const { contacts, message } = req.body;

        let client = clients.get(userId);

        // If client is missing but the user is authenticated, reinitialize
        if (!client) {
            const user = await User.findOne({ userId });
            if (user && user.isAuthenticated) {
                await initializeClient(userId);

                client = clients.get(userId); // Check again
                console.log(`Client reinitialized for ${userId}:`, !!client);
            }
        }

        if (!client) {
            return res.status(400).json({ error: "Client not initialized or not authenticated" });
        }


        console.log(message)

        let counter = 0;
        for (const phoneNumber of contacts) {
            const chatId = `${phoneNumber}@c.us`;
            try {
                await client.sendMessage(chatId, message);
                console.log(`Message sent to ${phoneNumber} for user ${userId}`);
                counter++;
            } catch (err) {
                console.error(`Failed to send message to ${phoneNumber} for user ${userId}:`, err);
            }
        }
        res.json({ status: "Messages sent", count: counter });
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));