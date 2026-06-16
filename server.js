const express = require('express');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. MIDDLEWARE SYSTEM ---
// Added explicit body parsing streams to avoid "Cannot destructure property 'phone' of 'req.body'"
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the root folder files statically (index.html, admin.html, etc.)
app.use(express.static(__dirname));

// Serve the uploads folder statically so images display natively instead of hitting a 404/undefined
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- 2. MULTER DISK STORAGE ENGINE ---
// Replaced memoryStorage with customized diskStorage to preserve proper image file extensions
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'receipt-' + uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });

// --- 3. SUPABASE CONNECTION ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aqqnvpzcvdzgkpmgwase.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_SERVICE_KEY && !SUPABASE_ANON_KEY) {
    console.error('FATAL: No Supabase key configured.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY);
const TABLE_NAME = 'users';

// --- 4. FILE UPLOAD ENDPOINT ---
// Custom route configured to handle frontend form drops matching the 'receipt' name signature
app.post('/api/upload-receipt', upload.single('receipt'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file received.' });
        }
        
        // Formulate the local server path to save into the user's bill profile arrays
        const fileUrl = `/uploads/${req.file.filename}`;
        return res.json({ success: true, fileUrl: fileUrl });
    } catch (err) {
        console.error("Upload routing fault:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// --- 5. AUTHENTICATION & CORE APP APIS ---
app.post('/api/register', async (req, res) => {
    try {
        let { phone, password, pin, referralCode } = req.body;
        if (!phone || !password || !pin) {
            return res.status(400).json({ success: false, message: 'Please fill out all required fields.' });
        }

        phone = phone.trim();
        const { data: existingUser } = await supabase.from(TABLE_NAME).select('phone').eq('phone', phone).maybeSingle();
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Phone number already registered.' });
        }

        const genRefCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const newUser = {
            phone,
            password,
            pin,
            balance: 1000,
            earnings: 0,
            referral_code: genRefCode,
            referred_by: referralCode ? referralCode.trim() : null,
            referred_count: 0,
            devices: JSON.stringify([]),
            bills: JSON.stringify([])
        };

        const { error } = await supabase.from(TABLE_NAME).insert([newUser]);
        if (error) throw error;

        if (referralCode) {
            const { data: referrer } = await supabase.from(TABLE_NAME).select('phone, referred_count').eq('referral_code', referralCode.trim()).maybeSingle();
            if (referrer) {
                await supabase.from(TABLE_NAME).update({ referred_count: (referrer.referred_count || 0) + 1 }).eq('phone', referrer.phone);
            }
        }

        delete newUser.password;
        newUser.devices = [];
        newUser.bills = [];
        return res.json({ success: true, user: newUser });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const { data: user, error } = await supabase.from(TABLE_NAME).select('*').eq('phone', phone.trim()).maybeSingle();
        
        if (error || !user || user.password !== password) {
            return res.status(400).json({ success: false, message: 'Invalid credentials.' });
        }

        try { user.devices = typeof user.devices === 'string' ? JSON.parse(user.devices) : (user.devices || []); } catch(e) { user.devices = []; }
        try { user.bills = typeof user.bills === 'string' ? JSON.parse(user.bills) : (user.bills || []); } catch(e) { user.bills = []; }
        try { user.bank_card = typeof user.bank_card === 'string' ? JSON.parse(user.bank_card) : (user.bank_card || null); } catch(e) { user.bank_card = null; }

        delete user.password;
        return res.json({ success: true, user });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/update-user', async (req, res) => {
    try {
        const { phone, balance, earnings, devices, bills, bank_card } = req.body;
        const { error } = await supabase.from(TABLE_NAME).update({
            balance: Number(balance),
            earnings: Number(earnings),
            devices: typeof devices === 'object' ? JSON.stringify(devices) : devices,
            bills: typeof bills === 'object' ? JSON.stringify(bills) : bills,
            bank_card: typeof bank_card === 'object' ? JSON.stringify(bank_card) : bank_card
        }).eq('phone', phone);

        if (error) throw error;
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/user/:phone', async (req, res) => {
    try {
        const { data: user } = await supabase.from(TABLE_NAME).select('*').eq('phone', req.params.phone).maybeSingle();
        if (!user) return res.status(404).json({ success: false });

        user.balance = user.balance ?? 1000;
        user.earnings = user.earnings ?? 0;
        user.referred_count = user.referred_count ?? 0;
        user.referral_code = user.referral_code ?? '';

        try { user.devices = typeof user.devices === 'string' ? JSON.parse(user.devices) : (user.devices || []); } catch(e) { user.devices = []; }
        try { user.bills = typeof user.bills === 'string' ? JSON.parse(user.bills) : (user.bills || []); } catch(e) { user.bills = []; }
        try { user.bank_card = typeof user.bank_card === 'string' && user.bank_card !== '' ? JSON.parse(user.bank_card) : null; } catch(e) { user.bank_card = null; }

        delete user.password;
        return res.json({ success: true, user });
    } catch (e) {
        return res.status(500).json({ success: false });
    }
});

// --- 6. ADMIN ENGINE APIS ---
app.get('/api/admin/users', async (req, res) => {
    try {
        const { data, error } = await supabase.from(TABLE_NAME).select('*');
        if (error) throw error;

        const processedUsers = data.map(user => {
            try { user.bills = typeof user.bills === 'string' ? JSON.parse(user.bills) : (user.bills || []); } catch(e) { user.bills = []; }
            try { user.devices = typeof user.devices === 'string' ? JSON.parse(user.devices) : (user.devices || []); } catch(e) { user.devices = []; }
            return user;
        });

        res.json({ success: true, users: processedUsers });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- NEW ROUTE FOR APPROVING RECHARGES ---
app.post('/api/admin/approve-recharge', async (req, res) => {
    try {
        const { phone, billId } = req.body;
        if (!phone || !billId) {
            return res.status(400).json({ success: false, message: 'Missing phone or billId.' });
        }

        // 1. Fetch user records from Supabase
        const { data: user, error: fetchErr } = await supabase
            .from(TABLE_NAME)
            .select('*')
            .eq('phone', phone)
            .maybeSingle();

        if (fetchErr || !user) return res.status(444).json({ success: false, message: 'User not found.' });

        // 2. Parse their bills array safely
        let bills = [];
        try {
            bills = typeof user.bills === 'string' ? JSON.parse(user.bills) : (user.bills || []);
        } catch(e) { bills = []; }

        // 3. Find the exact bill transaction card matching the ID
        const billIndex = bills.findIndex(b => b.id === billId);
        if (billIndex === -1) {
            return res.status(404).json({ success: false, message: 'Transaction ID not found.' });
        }

        // If it's already approved, stop here
        if (bills[billIndex].status === 'Approved') {
            return res.status(400).json({ success: false, message: 'This receipt was already approved.' });
        }

        // 4. Update status and increment balance pool numbers
        const depositAmount = Number(bills[billIndex].amount || 0);
        bills[billIndex].status = 'Approved';
        const newBalance = Number(user.balance || 0) + depositAmount;

        // 5. Save everything back down into Supabase
        const { error: updateErr } = await supabase
            .from(TABLE_NAME)
            .update({
                balance: newBalance,
                bills: JSON.stringify(bills)
            })
            .eq('phone', phone);

        if (updateErr) throw updateErr;

        return res.json({ success: true, message: 'Receipt approved and ledger balance updated!' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// --- 7. SERVE FRONTEND INDEX ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 8. START BACKEND ENGINE ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});