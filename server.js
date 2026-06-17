const express = require('express');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. MIDDLEWARE SYSTEM ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the root folder files statically (index.html, admin.html, etc.)
app.use(express.static(__dirname));

// --- 2. MULTER MEMORY STORAGE CONFIGURATION ---
const storage = multer.memoryStorage();
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
const BUCKET_NAME = 'receipts'; 

// --- 4. SUPABASE CLOUD FILE UPLOAD ENDPOINT ---
app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file received.' });
        }

        // Generate a clean, unique file path name
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(req.file.originalname);
        const filename = `receipt-${uniqueSuffix}${ext}`;

        // Upload the raw file buffer directly into your Supabase Storage Bucket
        const { data, error } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(filename, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (error) throw error;

        // Correct retrieval layout for getPublicUrl
        const { data: publicUrlData } = supabase.storage
            .from(BUCKET_NAME)
            .getPublicUrl(filename);

        const fileUrl = publicUrlData.publicUrl;
        return res.json({ success: true, fileUrl: fileUrl });

    } catch (err) {
        console.error("Cloud Upload routing fault:", err);
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
    let { phone, balance, earnings, devices, bills, bank_card } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, message: "Phone number is required." });
    }

    // --- PHONE NUMBER CLEANING ENGINE ---
    let digitsOnly = String(phone).replace(/\D/g, ''); 
    let baseNumber = digitsOnly; 
    
    if (baseNumber.startsWith('0')) {
        baseNumber = baseNumber.slice(1);
    } else if (baseNumber.startsWith('234') && baseNumber.length > 10) {
        baseNumber = baseNumber.slice(3);
    }

    const potentialMatches = [
        baseNumber,                
        '0' + baseNumber,           
        '234' + baseNumber,         
        '+234' + baseNumber,        
        digitsOnly,                 
        phone.trim()                
    ];

    try {
        let user = null;
        let matchedPhoneKey = null;

        for (const variant of potentialMatches) {
            const { data, error } = await supabase
                .from(TABLE_NAME) // FIXED: Changed 'profiles' to TABLE_NAME ('users')
                .select('*')
                .eq('phone', variant)
                .maybeSingle(); 

            if (data) {
                user = data;
                matchedPhoneKey = variant;
                break; 
            }
        }

        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: `User not found. Attempted all format variants for base value: "${baseNumber}"` 
            });
        }

        const updatedBalance = balance !== undefined ? Number(balance) : user.balance;
        const updatedEarnings = earnings !== undefined ? Number(earnings) : user.earnings;
        const updatedDevices = devices || user.devices || [];
        const updatedBills = bills || user.bills || [];
        const updatedBankCard = bank_card !== undefined ? bank_card : user.bank_card;

        const { error: updateError } = await supabase
            .from(TABLE_NAME) // FIXED: Changed 'profiles' to TABLE_NAME ('users')
            .update({
                balance: updatedBalance,
                earnings: updatedEarnings,
                devices: typeof updatedDevices !== 'string' ? JSON.stringify(updatedDevices) : updatedDevices,
                bills: typeof updatedBills !== 'string' ? JSON.stringify(updatedBills) : updatedBills,
                bank_card: typeof updatedBankCard !== 'string' && updatedBankCard !== null ? JSON.stringify(updatedBankCard) : updatedBankCard
            })
            .eq('phone', matchedPhoneKey);

        if (updateError) throw updateError;

        return res.json({ success: true });
    } catch (err) {
        console.error("Backend Multi-Format Update Error:", err.message);
        return res.status(500).json({ success: false, error: err.message });
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

app.post('/api/admin/approve-recharge', async (req, res) => {
    try {
        const { phone, billId } = req.body;
        if (!phone || !billId) {
            return res.status(400).json({ success: false, message: 'Missing phone or billId.' });
        }

        const { data: user, error: fetchErr } = await supabase
            .from(TABLE_NAME)
            .select('*')
            .eq('phone', phone)
            .maybeSingle();

        if (fetchErr || !user) return res.status(444).json({ success: false, message: 'User not found.' });

        let bills = [];
        try {
            bills = typeof user.bills === 'string' ? JSON.parse(user.bills) : (user.bills || []);
        } catch(e) { bills = []; }

        const billIndex = bills.findIndex(b => b.id === billId);
        if (billIndex === -1) {
            return res.status(404).json({ success: false, message: 'Transaction ID not found.' });
        }

        if (bills[billIndex].status === 'Approved') {
            return res.status(400).json({ success: false, message: 'This receipt was already approved.' });
        }

        const depositAmount = Number(bills[billIndex].amount || 0);
        bills[billIndex].status = 'Approved';
        const newBalance = Number(user.balance || 0) + depositAmount;

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

// --- FIXED: ADDED MISSING EXPLICIT ROUTE FOR ADMIN PANEL BALANCE INJECTION ---
app.post('/api/admin/update-balance', async (req, res) => {
    let { phone, balance } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, message: "Please specify a user mobile target." });
    }

    let digitsOnly = String(phone).replace(/\D/g, '');
    let baseNumber = digitsOnly;
    
    if (baseNumber.startsWith('0')) {
        baseNumber = baseNumber.slice(1);
    } else if (baseNumber.startsWith('234') && baseNumber.length > 10) {
        baseNumber = baseNumber.slice(3);
    }

    const potentialMatches = [
        baseNumber,
        '0' + baseNumber,
        '234' + baseNumber,
        '+234' + baseNumber,
        digitsOnly,
        phone.trim()
    ];

    try {
        let user = null;
        let matchedPhoneKey = null;

        for (const variant of potentialMatches) {
            const { data, error } = await supabase
                .from(TABLE_NAME) 
                .select('*')
                .eq('phone', variant)
                .maybeSingle();

            if (data) {
                user = data;
                matchedPhoneKey = variant;
                break;
            }
        }

        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: `Account entry missing from records for sequence lookup match: "${baseNumber}"` 
            });
        }

        const { error: updateError } = await supabase
            .from(TABLE_NAME) 
            .update({ balance: Number(balance) })
            .eq('phone', matchedPhoneKey);

        if (updateError) throw updateError;

        return res.json({ success: true });
    } catch (err) {
        console.error("Critical manual core accounting balance adjustment block error:", err.message);
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
