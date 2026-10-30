// language: JavaScript, file: server.js, target: Node.js 18+, Express, Playwright, SQLite
const express = require('express');
const { chromium } = require('playwright');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dbFile = path.join(__dirname, 'burner_fleet.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to local SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        email TEXT,
        cookies TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_username TEXT,
        target_count INTEGER,
        completed INTEGER DEFAULT 0,
        status TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

class MohmalClient {
    constructor() {
        this.baseUrl = 'https://www.mohmal.com';
        this.sessionToken = null;
    }

    async getSession() {
        try {
            const res = await axios.get(`${this.baseUrl}/en`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const cookies = res.headers['set-cookie'];
            if (cookies) {
                this.sessionToken = cookies.find(c => c.includes('_csrf') || c.includes('connect.sid'));
            }
        } catch (err) {
            console.error('Mohmal session init failed:', err.message);
        }
    }

    async generateEmail() {
        try {
            const res = await axios.post(`${this.baseUrl}/en/inbox/create`, {}, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Cookie': this.sessionToken || '',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            return {
                email: res.data.email || `burner_${Math.random().toString(36).substring(7)}@mohmal.im`,
                token: res.data.token || Date.now()
            };
        } catch (e) {
            const randomStr = Math.random().toString(36).substring(2, 10);
            return {
                email: `${randomStr}@mohmal.im`,
                token: randomStr
            };
        }
    }

    async fetchMessages(email) {
        try {
            const domain = email.split('@')[1];
            const name = email.split('@')[0];
            const res = await axios.get(`https://www.mohmal.com/en/inbox/${domain}/${name}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const match = res.data.match(/\b\d{6}\b/);
            return match ? match[0] : null;
        } catch (err) {
            return null;
        }
    }
}

class BurnerAutomation {
    constructor(targetUser, socketId) {
        this.targetUser = targetUser;
        this.socketId = socketId;
    }

    log(msg) {
        io.to(this.socketId).emit('log', { message: msg, timestamp: new Date().toISOString() });
    }

    async spawnAccount() {
        const mohmal = new MohmalClient();
        await mohmal.getSession();
        const burner = await mohmal.generateEmail();
        this.log(`Generated burner email: ${burner.email}`);

        const username = `usr_${Math.random().toString(36).substring(2, 10)}_${Math.floor(Math.random() * 900 + 100)}`;
        const password = `P@ssw0rd_${Math.random().toString(36).substring(2, 10)}!`;

        const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        try {
            this.log(`Navigating to registration portal for ${username}`);
            await page.goto('https://www.instagram.com/accounts/emailsignup/', { waitUntil: 'networkidle', timeout: 30000 });
            
            await page.fill('input[name="emailOrPhone"]', burner.email);
            await page.fill('input[name="fullName"]', username.toUpperCase());
            await page.fill('input[name="username"]', username);
            await page.fill('input[name="password"]', password);
            
            await page.click('button[type="submit"]');
            this.log('Submitted registration form, awaiting birthday prompt...');
            
            await page.waitForTimeout(4000);
            
            try {
                await page.selectOption('select[title*="Month"]', { index: Math.floor(Math.random() * 11) + 1 });
                await page.selectOption('select[title*="Day"]', { index: Math.floor(Math.random() * 28) + 1 });
                await page.selectOption('select[title*="Year"]', { value: '1998' });
                await page.click('button:has-text("Next")');
            } catch (e) {}

            this.log('Waiting for OTP verification code via Mohmal inbox...');
            let otp = null;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 4000));
                otp = await mohmal.fetchMessages(burner.email);
                if (otp) break;
                this.log(`Polling inbox attempt ${i+1}/15...`);
            }

            if (!otp) {
                throw new Error('OTP timeout: verification code not received.');
            }

            this.log(`Extracted OTP code: ${otp}. Submitting to platform...`);
            await page.fill('input[name="confirmationCode"]', otp);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(6000);

            const cookies = await context.cookies();
            const cookieString = JSON.stringify(cookies);

            db.run(`INSERT INTO accounts (username, password, email, cookies, status) VALUES (?, ?, ?, ?, ?)`,
                [username, password, burner.email, cookieString, 'VERIFIED']);
            this.log(`Account verified and stored: ${username}`);

            this.log(`Navigating to target profile: ${this.targetUser}`);
            await page.goto(`https://www.instagram.com/${this.targetUser}/`, { waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);

            const followButton = await page.$('button:has-text("Follow"), button:has-text("Follow Back")');
            if (followButton) {
                await followButton.click();
                this.log(`Successfully executed follow request for target: ${this.targetUser}`);
            } else {
                this.log('Follow button not located or already following.');
            }

            await browser.close();
            return true;
        } catch (err) {
            this.log(`Pipeline error: ${err.message}`);
            await browser.close();
            db.run(`INSERT INTO accounts (username, password, email, cookies, status) VALUES (?, ?, ?, ?, ?)`,
                [username, password, burner.email, '', 'FAILED']);
            return false;
        }
    }
}

app.get('/', (req, res) => {
    res.send(dashboardHtml);
});

app.post('/api/campaign/start', (req, res) => {
    const { target_username, target_count } = req.body;
    if (!target_username || !target_count) {
        return res.status(400).json({ error: 'Missing required parameters: target_username, target_count' });
    }

    db.run(`INSERT INTO campaigns (target_username, target_count, status) VALUES (?, ?, ?)`,
        [target_username, parseInt(target_count), 'RUNNING'], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const campaignId = this.lastID;
            res.json({ success: true, campaignId });
        });
});

app.get('/api/accounts', (req, res) => {
    db.all(`SELECT id, username, email, status, created_at FROM accounts ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

io.on('connection', (socket) => {
    socket.on('start_campaign', async (data) => {
        const { target_username, target_count } = data;
        socket.emit('log', { message: `Initializing campaign targeting @${target_username} for ${target_count} interactions.`, timestamp: new Date().toISOString() });
        
        let completed = 0;
        for (let i = 0; i < target_count; i++) {
            socket.emit('log', { message: `--- Spawning worker instance ${i + 1} of ${target_count} ---`, timestamp: new Date().toISOString() });
            const automation = new BurnerAutomation(target_username, socket.id);
            const success = await automation.spawnAccount();
            if (success) completed++;
            
            socket.emit('progress', { completed, total: target_count });
            
            const delay = Math.floor(Math.random() * 10000) + 5000;
            socket.emit('log', { message: `Cooling down for ${Math.round(delay/1000)} seconds before next instance...`, timestamp: new Date().toISOString() });
            await new Promise(r => setTimeout(r, delay));
        }
        socket.emit('log', { message: `Campaign completed. Successfully deployed ${completed}/${target_count} accounts.`, timestamp: new Date().toISOString() });
    });
});

const dashboardHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CYBR-MAHI Control Center</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="/socket.io/socket.io.js"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 font-mono min-h-screen p-6">
    <div class="max-w-7xl mx-auto space-y-6">
        <header class="border-b border-zinc-800 pb-4 flex justify-between items-center">
            <h1 class="text-xl font-bold tracking-wider text-emerald-400">[amr,jelbraik] CYBR-MAHI // BURNER FLEET MANAGER</h1>
            <span class="text-xs text-zinc-500">SECURE TERMINAL ACTIVE</span>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="bg-zinc-900 border border-zinc-800 p-6 rounded-lg space-y-4">
                <h2 class="text-lg font-semibold text-zinc-200 border-b border-zinc-800 pb-2">Campaign Parameters</h2>
                <div>
                    <label class="block text-xs uppercase tracking-wider text-zinc-400 mb-1">Target Username</label>
                    <input type="text" id="target" placeholder="target_account" class="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500">
                </div>
                <div>
                    <label class="block text-xs uppercase tracking-wider text-zinc-400 mb-1">Target Count</label>
                    <input type="number" id="quantity" value="5" min="1" max="100" class="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500">
                </div>
                <button onclick="startCampaign()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-zinc-950 font-bold py-2 rounded transition tracking-wider uppercase text-sm">Initialize Campaign</button>
            </div>

            <div class="lg:col-span-2 bg-zinc-900 border border-zinc-800 p-6 rounded-lg flex flex-col h-[400px]">
                <h2 class="text-lg font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">Pipeline Telemetry</h2>
                <div id="logs" class="flex-1 bg-zinc-950 border border-zinc-800 rounded p-4 overflow-y-auto text-xs space-y-2 font-mono">
                    <div class="text-zinc-500">[System] Awaiting campaign sequence...</div>
                </div>
            </div>
        </div>

        <div class="bg-zinc-900 border border-zinc-800 p-6 rounded-lg space-y-4">
            <div class="flex justify-between items-center border-b border-zinc-800 pb-2">
                <h2 class="text-lg font-semibold text-zinc-200">Worker Fleet Database</h2>
                <button onclick="loadAccounts()" class="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1 rounded text-xs">Refresh Data</button>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left text-xs">
                    <thead>
                        <tr class="border-b border-zinc-800 text-zinc-400">
                            <th class="py-2 px-3">ID</th>
                            <th class="py-2 px-3">Username</th>
                            <th class="py-2 px-3">Burner Email</th>
                            <th class="py-2 px-3">Status</th>
                            <th class="py-2 px-3">Timestamp</th>
                        </tr>
                    </thead>
                    <tbody id="accountTable">
                        <tr><td colspan="5" class="py-4 text-center text-zinc-500">No records loaded.</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        const socket = io();

        socket.on('log', (data) => {
            const logsDiv = document.getElementById('logs');
            const entry = document.createElement('div');
            entry.className = 'text-emerald-400';
            entry.textContent = \`[\${data.timestamp}] \${data.message}\`;
            logsDiv.appendChild(entry);
            logsDiv.scrollTop = logsDiv.scrollHeight;
        });

        socket.on('progress', (data) => {
            loadAccounts();
        });

        function startCampaign() {
            const target = document.getElementById('target').value;
            const quantity = document.getElementById('quantity').value;
            if (!target) {
                alert('Provide a target username.');
                return;
            }
            fetch('/api/campaign/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_username: target, target_count: quantity })
            }).then(res => res.json()).then(data => {
                if (data.success) {
                    socket.emit('start_campaign', { target_username: target, target_count: quantity });
                }
            });
        }

        function loadAccounts() {
            fetch('/api/accounts').then(res => res.json()).then(data => {
                const tbody = document.getElementById('accountTable');
                tbody.innerHTML = '';
                if (data.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-zinc-500">No accounts created yet.</td></tr>';
                    return;
                }
                data.forEach(acc => {
                    const row = document.createElement('tr');
                    row.className = 'border-b border-zinc-800/50 hover:bg-zinc-800/20';
                    row.innerHTML = \`
                        <td class="py-2 px-3">\${acc.id}</td>
                        <td class="py-2 px-3 font-semibold text-zinc-200">\${acc.username}</td>
                        <td class="py-2 px-3 text-zinc-400">\${acc.email}</td>
                        <td class="py-2 px-3"><span class="px-2 py-0.5 rounded text-[10px] \${acc.status === 'VERIFIED' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-red-950 text-red-400 border border-red-800'}">\${acc.status}</span></td>
                        <td class="py-2 px-3 text-zinc-500">\${acc.created_at}</td>
                    \`;
                    tbody.appendChild(row);
                });
            });
        }

        loadAccounts();
    </script>
</body>
</html>
`;

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`CYBR-MAHI execution environment online on port ${PORT}`);
});
