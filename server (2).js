require('dotenv').config(); // Ortam değişkenlerini yükle (.env dosyasından)
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path'); // Needed for serving index.html

const app = express();
const PORT = process.env.PORT || 3000; // cPanel'in portunu veya fallback olarak 3000'i kullan

const dbFile = './database.db';

// !!! GÜVENLİK: BU ANAHTARI KESİNLİKLE .env DOSYASINDA TANIMLAYIN !!!
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error("KRİTİK HATA: JWT_SECRET ortam değişkeni .env dosyasında tanımlanmamış!");
    process.exit(1); // Gizli anahtar yoksa sunucuyu başlatma
}
const saltRounds = 10;

// --- Veritabanı Bağlantısı ---
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Veritabanı açılırken hata oluştu", err.message);
         process.exit(1); // Veritabanı açılamazsa devam etme
    } else {
        console.log("SQLite veritabanına başarıyla bağlanıldı.");
        initializeDb();
    }
});

// --- Veritabanı Başlatma Fonksiyonu ---
function initializeDb() {
    db.serialize(() => {
        // Enable Foreign Keys (Veri Bütünlüğü İçin Önemli)
        db.run("PRAGMA foreign_keys = ON;");

        // Businesses Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS businesses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_code TEXT UNIQUE NOT NULL COLLATE NOCASE, -- UNIQUE ve Büyük/Küçük harf duyarsız
            password_hash TEXT NOT NULL,
            name TEXT,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')) -- ISO 8601 UTC
        )`);

        // Customers Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            firstName TEXT NOT NULL,
            lastName TEXT NOT NULL,
            phone TEXT,
            district TEXT,
            address TEXT,
            company TEXT,
            taxNo TEXT,
            taxOffice TEXT,
            isActive BOOLEAN DEFAULT 1, -- 1: Aktif, 0: Pasif
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        )`);

        // Product Groups Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS product_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            name TEXT NOT NULL COLLATE NOCASE,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            UNIQUE(business_id, name)
        )`);

        // Products Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            group_id INTEGER,
            name TEXT NOT NULL COLLATE NOCASE,
            current_stock INTEGER DEFAULT 0,
            last_unit_cost REAL,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (group_id) REFERENCES product_groups(id) ON DELETE SET NULL,
            UNIQUE(business_id, name)
        )`);

        // Service Records Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS service_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            customer_id INTEGER,
            customerName_snapshot TEXT,
            date TEXT,
            plate TEXT COLLATE NOCASE,
            km INTEGER,
            complaint TEXT,
            subtotal REAL DEFAULT 0,
            vatPercent REAL DEFAULT 20,
            vatAmount REAL DEFAULT 0,
            grandTotal REAL DEFAULT 0,
            status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'COMPLETED', 'CANCELLED')),
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
        )`);

        // Service Items Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS service_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            service_record_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('Hizmet', 'Ürün')),
            product_id INTEGER NULL,
            description TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            unitPrice REAL NOT NULL CHECK(unitPrice >= 0),
            total REAL NOT NULL,
            cost_at_time REAL NULL,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (service_record_id) REFERENCES service_records(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
        )`);

        // Customer Accounts Tablosu (Cari Hesaplar)
        db.run(`CREATE TABLE IF NOT EXISTS customer_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            customer_id INTEGER NOT NULL,
            current_balance REAL DEFAULT 0,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
            UNIQUE(business_id, customer_id)
        )`);

        // Customer Transactions Tablosu (Cari Hesap Hareketleri)
        db.run(`CREATE TABLE IF NOT EXISTS customer_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            customer_id INTEGER NOT NULL,
            timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            description TEXT,
            amount REAL NOT NULL,
            new_balance REAL NOT NULL,
            related_service_record_id INTEGER NULL,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
            FOREIGN KEY (related_service_record_id) REFERENCES service_records(id) ON DELETE SET NULL
        )`);

        // Suppliers Tablosu
        db.run(`CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            name TEXT NOT NULL COLLATE NOCASE,
            contact_person TEXT,
            phone TEXT,
            email TEXT,
            address TEXT,
            taxNo TEXT,
            taxOffice TEXT,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            UNIQUE(business_id, name)
        )`);

         // Supplier Accounts Tablosu
         db.run(`CREATE TABLE IF NOT EXISTS supplier_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            current_balance REAL DEFAULT 0,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
            UNIQUE(business_id, supplier_id)
        )`);

         // Supplier Transactions Tablosu
         db.run(`CREATE TABLE IF NOT EXISTS supplier_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            description TEXT,
            amount REAL NOT NULL,
            new_balance REAL NOT NULL,
            invoice_ref TEXT NULL,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
        )`);

        // Stock Movements Tablosu (Stok Hareket Kayıtları)
        db.run(`CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('IN_PURCHASE', 'OUT_SALE', 'ADJUST_MANUAL', 'IN_RETURN')),
            quantity INTEGER NOT NULL,
            unit_cost REAL NULL,
            timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            related_service_item_id INTEGER NULL,
            related_supplier_transaction_id INTEGER NULL,
            manual_reason TEXT NULL,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (related_service_item_id) REFERENCES service_items(id) ON DELETE SET NULL,
            FOREIGN KEY (related_supplier_transaction_id) REFERENCES supplier_transactions(id) ON DELETE SET NULL
        )`);

        // Invoices Tablosu (Fatura)
        db.run(`CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            service_record_id INTEGER UNIQUE NOT NULL, -- Her servis kaydının en fazla 1 faturası olabilir
            customer_id INTEGER, -- Fatura anındaki müşteri ID
            invoice_number TEXT NOT NULL, -- Fatura Numarası (işletme bazında benzersiz olmalı)
            invoice_date TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')), -- Fatura tarihi
            due_date TEXT NULL, -- Vade tarihi (opsiyonel)
            customer_details_snapshot TEXT, -- Fatura anındaki Müşteri bilgileri (JSON)
            subtotal REAL NOT NULL,
            vat_percent REAL NOT NULL,
            vat_amount REAL NOT NULL,
            grand_total REAL NOT NULL,
            status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED')), -- Fatura durumu
            payment_date TEXT NULL, -- Ödeme tarihi (opsiyonel)
            notes TEXT NULL, -- Fatura notları (opsiyonel)
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'utc')),
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            FOREIGN KEY (service_record_id) REFERENCES service_records(id) ON DELETE CASCADE, -- Servis kaydı silinirse fatura da silinir
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
            UNIQUE(business_id, invoice_number) -- Fatura numarası işletme içinde benzersiz
        )`);

        // Fatura numarası ve servis kaydı için indexler (performans için)
         db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_business_number ON invoices (business_id, invoice_number)`);
         db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_service_record ON invoices (service_record_id)`);

        // ... (diğer tablo tanımları) ...
        console.log("Veritabanı tabloları kontrol edildi/oluşturuldu.");
    });
}

// --- Middleware ---
app.use(cors()); // Cross-Origin Resource Sharing'e izin ver
app.use(express.json()); // Gelen JSON request body'lerini parse et

// <<<<<<<< authenticateToken TANIMI BURADA >>>>>>>>>
// Authentication Middleware (Token Doğrulama)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN_STRING

    if (token == null) {
        return res.status(401).json({ message: 'Yetkilendirme başarısız: Token bulunamadı' }); // Token yok
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.warn("JWT Verification Error:", err.message); // Loglama
            return res.status(403).json({ message: 'Yetkilendirme başarısız: Geçersiz token' }); // Token geçersiz veya süresi dolmuş
        }
        // Token geçerliyse, user bilgisini request'e ekle
        req.user = user; // user objesi { businessId: id, business_code: code } içeriyor
        next(); // Sonraki middleware veya route handler'a geç
    });
};
// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

// --- Yardımcı Fonksiyonlar ---
// Mevcut UTC zaman damgasını ISO 8601 formatında al
function getCurrentISOTimestamp() {
    return new Date().toISOString();
}

// Verilen miktarı para formatına çevir (Backend logları için)
function formatCurrencyForLog(amount) {
     if (typeof amount !== 'number' || isNaN(amount)) return '0,00 TRY';
     return amount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' });
}


// YENİ: Müşteriyi Silme Endpoint'i
app.delete('/api/customers/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId;
    const customerId = req.params.id;

    // 1. Önce Müşterinin Bakiyesini Kontrol Et
    getOrCreateCustomerAccount(businessId, customerId, (err, account) => {
        // Hesap alınırken hata olursa (çok nadir), yine de silmeye çalışalım mı?
        // Şimdilik hata durumunda işlemi durduralım.
        if (err) {
             console.error(`Müşteri (ID: ${customerId}) silme öncesi hesap kontrol hatası:`, err);
             return res.status(500).json({ message: 'Müşteri silme öncesi hesap kontrolü başarısız oldu.' });
        }

        // Hesap var ve bakiye 0 değilse silme işlemini engelle
        // current_balance null veya 0 ise silmeye izin verilir.
        if (account && account.current_balance !== 0 && account.current_balance !== null) {
            const balanceFormatted = formatCurrencyForLog(account.current_balance);
            console.warn(`Müşteri (ID: ${customerId}) silme engellendi. Bakiye: ${balanceFormatted}`);
            return res.status(409).json({ // 409 Conflict durumu uygun
                message: `Müşteri silinemez: Cari bakiye (${balanceFormatted}) sıfır değil. Lütfen önce bakiyeyi sıfırlayın veya müşteriyi pasif yapın.`
            });
        }

        // Bakiye 0 veya hesap yoksa silme işlemine devam et
        // ON DELETE CASCADE ayarları sayesinde ilgili account ve transactionlar da silinecek.
        // ON DELETE SET NULL ayarı sayesinde service_records'daki customer_id null olacak.
        db.run(`DELETE FROM customers WHERE id = ? AND business_id = ?`, [customerId, businessId], function(deleteErr) {
            if (deleteErr) {
                console.error(`Müşteri (ID: ${customerId}) silinirken DB hatası:`, deleteErr);
                return res.status(500).json({ message: 'Müşteri silinirken bir veritabanı hatası oluştu.' });
            }
            if (this.changes === 0) {
                // Bu durum, müşteri zaten yoksa veya başka bir işletmeye aitse oluşur.
                return res.status(404).json({ message: 'Silinecek müşteri bulunamadı.' });
            }

            console.log(`Müşteri (ID: ${customerId}) İşletme (ID: ${businessId}) tarafından başarıyla silindi.`);
            // İlişkili hesap ve transactionların da cascade ile silindiğini varsayıyoruz.
            res.status(200).json({ message: 'Müşteri ve ilişkili cari hesap bilgileri kalıcı olarak silindi.' });
        });
    });
});


// Müşteri cari hesabını bul veya oluştur
function getOrCreateCustomerAccount(business_id, customer_id, callback) {
    db.get(`SELECT * FROM customer_accounts WHERE business_id = ? AND customer_id = ?`, [business_id, customer_id], (err, account) => {
        if (err) return callback(err);
        if (account) return callback(null, account); // Hesap varsa döndür

        // Hesap yoksa oluştur
        const timestamp = getCurrentISOTimestamp();
        db.run(`INSERT INTO customer_accounts (business_id, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
               [business_id, customer_id, timestamp, timestamp], function (err) {
            if (err) return callback(err);
            // Yeni oluşturulan hesabı geri döndür
            callback(null, { id: this.lastID, business_id, customer_id, current_balance: 0, created_at: timestamp, updated_at: timestamp });
        });
    });
}

// Tedarikçi cari hesabını bul veya oluştur
function getOrCreateSupplierAccount(business_id, supplier_id, callback) {
    db.get(`SELECT * FROM supplier_accounts WHERE business_id = ? AND supplier_id = ?`, [business_id, supplier_id], (err, account) => {
        if (err) return callback(err);
        if (account) return callback(null, account);

        const timestamp = getCurrentISOTimestamp();
        db.run(`INSERT INTO supplier_accounts (business_id, supplier_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
               [business_id, supplier_id, timestamp, timestamp], function (err) {
            if (err) return callback(err);
            callback(null, { id: this.lastID, business_id, supplier_id, current_balance: 0, created_at: timestamp, updated_at: timestamp });
        });
    });
}

// Müşteri bakiyesini güncelle ve işlem kaydı ekle (Transaction İçinde)
// callback(err) şeklinde hata döndürür
function updateCustomerBalance(business_id, customer_id, amount, description, serviceRecordId, callback) {
    getOrCreateCustomerAccount(business_id, customer_id, (err, account) => {
        if (err) {
             console.error(`Hesap alınırken/oluşturulurken hata (Müşteri ID: ${customer_id}):`, err);
             return callback(new Error('Müşteri hesabı alınamadı veya oluşturulamadı.'));
         }

        const newBalance = (account.current_balance || 0) + amount; // Null ise 0 al
        const timestamp = getCurrentISOTimestamp();

        // Transaction'ı çağıran fonksiyon yönettiği için burada transaction başlatmıyoruz!
        // Bu fonksiyon bir transaction içinde çağrılmalı.
        db.run(`INSERT INTO customer_transactions (business_id, customer_id, timestamp, description, amount, new_balance, related_service_record_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
               [business_id, customer_id, timestamp, description, amount, newBalance, serviceRecordId], (insertErr) => {
            if (insertErr) {
                console.error("Müşteri işlemi eklenirken DB hatası:", insertErr);
                return callback(insertErr); // Hata varsa işlemi çağıran fonksiyona bildir (ROLLBACK yapmalı)
            }
            db.run(`UPDATE customer_accounts SET current_balance = ?, updated_at = ? WHERE id = ?`,
                   [newBalance, timestamp, account.id], (updateErr) => {
                if (updateErr) {
                    console.error("Müşteri bakiyesi güncellenirken DB hatası:", updateErr);
                    return callback(updateErr); // Hata varsa işlemi çağıran fonksiyona bildir (ROLLBACK yapmalı)
                }
                callback(null); // Başarılı (COMMIT dışarıda yapılacak)
            });
        });
    });
}

// Tedarikçi bakiyesini güncelle ve işlem kaydı ekle (Transaction İçinde)
// callback(err, transactionId) döner
function updateSupplierBalance(business_id, supplier_id, amount, description, invoiceRef, callback) {
     getOrCreateSupplierAccount(business_id, supplier_id, (err, account) => {
        if (err) {
            console.error(`Tedarikçi hesabı alınırken/oluşturulurken hata (ID: ${supplier_id}):`, err);
            return callback(new Error('Tedarikçi hesabı alınamadı veya oluşturulamadı.'));
        }

        const newBalance = (account.current_balance || 0) + amount; // Pozitif: Borç artışı, Negatif: Ödeme
        const timestamp = getCurrentISOTimestamp();

        // Transaction'ı çağıran fonksiyon yönetiyor.
        db.run(`INSERT INTO supplier_transactions (business_id, supplier_id, timestamp, description, amount, new_balance, invoice_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
               [business_id, supplier_id, timestamp, description, amount, newBalance, invoiceRef], function(insertErr) { // lastID için function() kullan
            if (insertErr) {
                console.error("Tedarikçi işlemi eklenirken DB hatası:", insertErr);
                return callback(insertErr); // Hata varsa bildir (ROLLBACK dışarıda)
            }
            const transactionId = this.lastID; // Eklenen işlem ID'si

            db.run(`UPDATE supplier_accounts SET current_balance = ?, updated_at = ? WHERE id = ?`,
                   [newBalance, timestamp, account.id], (updateErr) => {
                if (updateErr) {
                    console.error("Tedarikçi bakiyesi güncellenirken DB hatası:", updateErr);
                    return callback(updateErr); // Hata varsa bildir (ROLLBACK dışarıda)
                }
                // Başarılı, transaction ID'sini de döndür. COMMIT dışarıda yapılacak.
                callback(null, transactionId);
            });
        });
    });
}


// Stok miktarını ayarla ve hareket kaydı ekle (Transaction'ı KENDİSİ BAŞLATMAZ)
// callback(err) veya callback(null, movementId) şeklinde döner.
// Hata olursa, çağıran fonksiyonun transaction'ı ROLLBACK yapması gerekir.
function adjustStock(business_id, product_id, quantityChange, type, unitCost, serviceItemId, supplierTransactionId, manualReason, callback) {
    const timestamp = getCurrentISOTimestamp();

    // 1. Ürünün varlığını ve mevcut stoğunu kontrol et
    //    Bu kontrol, çağıran fonksiyonun transaction'ından ÖNCE yapılmalı idealde,
    //    ama burada bırakmak da atomikliği transaction içinde sağlar.
    //    Dış transaction'ın bunu yönettiğini varsayalım.
    db.get('SELECT current_stock FROM products WHERE id = ? AND business_id = ?', [product_id, business_id], (err, product) => {
        if (err) {
            console.error("Stok ayarlama öncesi ürün kontrol hatası:", err);
            return callback(new Error("Stok kontrolü sırasında veritabanı hatası oluştu."));
        }
        if (!product) {
            // Hata yerine null dönmek bazen daha iyi olabilir, çağıran karar versin.
            // Şimdilik hata döndürelim.
            return callback(new Error(`Stok ayarlanacak ürün (ID: ${product_id}) bulunamadı.`));
        }

        const currentStock = product.current_stock || 0;
        const projectedStock = currentStock + quantityChange;

        // 2. Negatif Stok Kontrolü (Sadece stok azaltan işlemler için)
        if (quantityChange < 0 && projectedStock < 0) {
            console.warn(`Negatif stok engellendi - Ürün ID: ${product_id}. Mevcut: ${currentStock}, Değişim: ${quantityChange}, Sonuç: ${projectedStock}`);
            return callback(new Error(`Yetersiz stok! Mevcut stok: ${currentStock}. ${Math.abs(quantityChange)} adet çıkış yapılamaz.`));
        }

        // 3. Stok Hareketini Ekle (Transaction'ı çağıran fonksiyon yönetiyor)
        db.run(`INSERT INTO stock_movements
                (business_id, product_id, type, quantity, unit_cost, timestamp, related_service_item_id, related_supplier_transaction_id, manual_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
               [business_id, product_id, type, quantityChange, unitCost, timestamp, serviceItemId, supplierTransactionId, manualReason], function(insertErr) {
            if (insertErr) {
                console.error("Stok hareketi eklenirken DB hatası:", insertErr);
                return callback(insertErr); // Hata oluştu, çağıran ROLLBACK yapmalı
            }
            const movementId = this.lastID; // Eklenen hareket ID'si

            // 4. Ürün Tablosundaki Stoğu Güncelle
            const costUpdateClause = (type.startsWith('IN') && unitCost !== null && unitCost !== undefined)
                ? `, last_unit_cost = ${unitCost}` : '';

            db.run(`UPDATE products
                    SET current_stock = current_stock + (?), updated_at = ? ${costUpdateClause}
                    WHERE id = ? AND business_id = ?`,
                   [quantityChange, timestamp, product_id, business_id], function(updateErr) {
                if (updateErr) {
                    console.error("Ürün stoğu güncellenirken DB hatası:", updateErr);
                    return callback(updateErr); // Hata oluştu, çağıran ROLLBACK yapmalı
                }
                if (this.changes === 0) {
                    console.warn(`Stok güncelleme başarısız, ürün bulunamadı? - Ürün ID: ${product_id}.`);
                    return callback(new Error("Stok güncellenemedi, ürün bulunamadı veya başka bir sorun oluştu."));
                }
                // Başarılı, hareket ID'sini döndür. COMMIT dışarıda yapılacak.
                callback(null, movementId);
            });
        });
    });
    // BEGIN/COMMIT/ROLLBACK YOK!
}

// Basit fatura numarası üretme (Örn: INV-2023-101)
function generateInvoiceNumber(invoiceId) {
    const year = new Date().getFullYear();
    // ID'yi 5 haneye tamamla, başına 0 ekleyerek
    const paddedId = String(invoiceId).padStart(5, '0');
    return `INV-${year}-${paddedId}`; // Örnek format, işletmeye göre değişebilir
}

// --- API Routes ---

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Authentication Routes (Public) ---
app.post('/api/register', async (req, res) => {
    const { business_code, password, name } = req.body;
    if (!business_code || !password || !name) return res.status(400).json({ message: 'İşletme kodu, şifre ve işletme adı zorunludur' });
    if (password.length < 6) return res.status(400).json({ message: 'Şifre en az 6 karakter olmalıdır' });
    try {
        db.get(`SELECT id FROM businesses WHERE business_code = ? COLLATE NOCASE`, [business_code], async (err, row) => {
            if (err) return res.status(500).json({ message: 'Kayıt sırasında veritabanı hatası' });
            if (row) return res.status(409).json({ message: 'Bu işletme kodu zaten kullanımda' });
            const hashedPassword = await bcrypt.hash(password, saltRounds);
            const timestamp = getCurrentISOTimestamp();
            db.run(`INSERT INTO businesses (business_code, password_hash, name, created_at) VALUES (?, ?, ?, ?)`,
                   [business_code, hashedPassword, name, timestamp], function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ message: 'Bu işletme kodu az önce kaydedildi.' });
                    console.error("İşletme ekleme hatası:", err);
                    return res.status(500).json({ message: 'İşletme kaydedilirken bir hata oluştu' });
                }
                res.status(201).json({ message: 'İşletme başarıyla kaydedildi' });
            });
        });
    } catch (error) { res.status(500).json({ message: 'Kayıt sırasında sunucu hatası' }); }
});

app.post('/api/login', (req, res) => {
    const { business_code, password } = req.body;
    if (!business_code || !password) return res.status(400).json({ message: 'İşletme kodu ve şifre zorunludur' });
    db.get(`SELECT id, password_hash, name FROM businesses WHERE business_code = ? COLLATE NOCASE`, [business_code], async (err, business) => {
        if (err) return res.status(500).json({ message: 'Giriş sırasında veritabanı hatası' });
        if (!business) return res.status(401).json({ message: 'Geçersiz işletme kodu veya şifre' });
        try {
            const match = await bcrypt.compare(password, business.password_hash);
            if (!match) return res.status(401).json({ message: 'Geçersiz işletme kodu veya şifre' });
            const userPayload = { businessId: business.id, business_code: business_code };
            const accessToken = jwt.sign(userPayload, JWT_SECRET, { expiresIn: '8h' });
            res.json({ accessToken: accessToken, businessName: business.name });
        } catch (error) { res.status(500).json({ message: 'Giriş sırasında sunucu hatası' }); }
    });
});


// --- Protected Routes (Require Authentication) ---

// --- Invoice Routes (Fatura İşlemleri) ---
app.post('/api/service-records/:recordId/invoice', authenticateToken, async (req, res) => {
    const businessId = req.user.businessId;
    const recordId = req.params.recordId;
    const { notes, due_date } = req.body;

    // Transaction Başlat: Fatura kontrolü, oluşturma, numara atama
    db.serialize(() => {
        db.run("BEGIN TRANSACTION;", async (beginErr) => {
             if (beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });

            try {
                // 1. Servis kaydını bul ve kontrol et
                const record = await new Promise((resolve, reject) => {
                    db.get(`SELECT sr.*, c.firstName, c.lastName, c.address, c.district, c.taxNo, c.taxOffice, c.company
                            FROM service_records sr
                            LEFT JOIN customers c ON sr.customer_id = c.id AND sr.business_id = c.business_id
                            WHERE sr.id = ? AND sr.business_id = ?`, [recordId, businessId], (err, row) => {
                        if (err) return reject(new Error('Servis kaydı alınırken DB hatası'));
                        resolve(row);
                    });
                });

                if (!record) { db.run("ROLLBACK;"); return res.status(404).json({ message: 'Faturası oluşturulacak servis kaydı bulunamadı.' }); }
                if (record.status !== 'COMPLETED') { db.run("ROLLBACK;"); return res.status(400).json({ message: 'Sadece "Tamamlandı" durumundaki servis kayıtları için fatura oluşturulabilir.' }); }
                if (!record.customer_id) { db.run("ROLLBACK;"); return res.status(400).json({ message: 'Fatura oluşturmak için servis kaydının bir müşteri ile ilişkili olması gerekir.' }); }

                // 2. Bu servis kaydı için zaten fatura var mı kontrol et
                const existingInvoice = await new Promise((resolve, reject) => {
                    db.get(`SELECT id FROM invoices WHERE service_record_id = ? AND business_id = ?`, [recordId, businessId], (err, row) => {
                        if (err) return reject(new Error('Mevcut fatura kontrolü sırasında DB hatası'));
                        resolve(row);
                    });
                });

                if (existingInvoice) { db.run("ROLLBACK;"); return res.status(409).json({ message: 'Bu servis kaydı için zaten bir fatura oluşturulmuş.', invoiceId: existingInvoice.id }); }

                // 3. Fatura verilerini hazırla
                const invoiceDate = getCurrentISOTimestamp();
                const customerDetailsSnapshot = JSON.stringify({
                    id: record.customer_id, firstName: record.firstName, lastName: record.lastName,
                    company: record.company, address: record.address, district: record.district,
                    taxNo: record.taxNo, taxOffice: record.taxOffice,
                });

                // 4. Faturayı Veritabanına Ekle (Numarasız olarak, PENDING ile)
                const invoiceData = [
                    businessId, recordId, record.customer_id, 'PENDING_NUMBER', invoiceDate, due_date || null, customerDetailsSnapshot,
                    record.subtotal, record.vatPercent, record.vatAmount, record.grandTotal, 'SENT', // Durumu direkt SENT yapalım
                    null, notes || null, invoiceDate, invoiceDate
                ];

                const newInvoiceId = await new Promise((resolve, reject) => {
                    db.run(`INSERT INTO invoices (business_id, service_record_id, customer_id, invoice_number, invoice_date, due_date, customer_details_snapshot,
                                                subtotal, vat_percent, vat_amount, grand_total, status, payment_date, notes, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, invoiceData, function(insertErr) {
                        if (insertErr) return reject(new Error(`Fatura oluşturulurken veritabanı hatası: ${insertErr.message}`));
                        resolve(this.lastID);
                    });
                });

                // 5. Fatura Numarasını Oluştur ve Güncelle
                const invoiceNumber = generateInvoiceNumber(newInvoiceId);
                await new Promise((resolve, reject) => {
                    db.run(`UPDATE invoices SET invoice_number = ? WHERE id = ?`, [invoiceNumber, newInvoiceId], function(updateErr) {
                        if (updateErr) return reject(new Error(`Fatura numarası güncellenemedi: ${updateErr.message}`));
                        if (this.changes === 0) return reject(new Error('Fatura ID bulunamadı (numara güncelleme).'));
                        resolve();
                    });
                });

                // Her şey başarılı, COMMIT et
                db.run("COMMIT;", (commitErr) => {
                    if (commitErr) {
                         console.error("Fatura oluşturma COMMIT hatası:", commitErr);
                         // Rollback denemesi riskli, hata loglandı
                         return res.status(500).json({ message: 'Fatura oluşturuldu ancak işlem kaydedilirken hata oluştu.' });
                     }
                     res.status(201).json({
                         message: 'Fatura başarıyla oluşturuldu.',
                         invoiceId: newInvoiceId,
                         invoiceNumber: invoiceNumber
                     });
                 });

            } catch (error) { // Üstteki try bloğunun hatası
                console.error("Fatura Oluşturma Genel Hata:", error);
                db.run("ROLLBACK;"); // Hata durumunda geri al
                res.status(500).json({ message: `Fatura oluşturma sırasında hata: ${error.message}` });
            }
        }); // End Transaction
    }); // End Serialize
});

app.get('/api/invoices/:invoiceId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId;
    const invoiceId = req.params.invoiceId;
    db.get(`SELECT inv.*, sr.plate as service_plate, sr.date as service_date
            FROM invoices inv
            LEFT JOIN service_records sr ON inv.service_record_id = sr.id AND inv.business_id = sr.business_id
            WHERE inv.id = ? AND inv.business_id = ?`,
           [invoiceId, businessId], (err, invoice) => {
        if (err) return res.status(500).json({ message: 'Fatura detayları alınırken hata.' });
        if (!invoice) return res.status(404).json({ message: 'Fatura bulunamadı.' });
        try {
            if (invoice.customer_details_snapshot) invoice.customer_details_snapshot = JSON.parse(invoice.customer_details_snapshot);
        } catch (parseErr) { console.warn(`Invoice ${invoiceId} customer snapshot parse error`); }
        db.all(`SELECT * FROM service_items WHERE service_record_id = ? AND business_id = ? ORDER BY id`,
               [invoice.service_record_id, businessId], (itemErr, items) => {
            invoice.items = itemErr ? [] : (items || []);
            res.json(invoice);
        });
    });
});

app.put('/api/invoices/:invoiceId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId;
    const invoiceId = req.params.invoiceId;
    const { status, payment_date, notes } = req.body;

    if (!status || !['PAID', 'CANCELLED', 'SENT', 'OVERDUE'].includes(status)) {
         return res.status(400).json({ message: 'Geçersiz fatura durumu.' });
    }
    // TODO: Durum geçiş mantığını kontrol et (backend'de)

    const updates = []; const params = []; const timestamp = getCurrentISOTimestamp();
    updates.push("status = ?"); params.push(status);
    if (status === 'PAID' && payment_date) {
         // Tarih formatını kontrol et (YYYY-MM-DD)
         if (!/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) return res.status(400).json({ message: 'Geçersiz ödeme tarihi formatı (YYYY-MM-DD).' });
         updates.push("payment_date = ?"); params.push(payment_date);
    } else if (status !== 'PAID') { updates.push("payment_date = NULL"); }
    if (notes !== undefined) { updates.push("notes = ?"); params.push(notes); }
    updates.push("updated_at = ?"); params.push(timestamp);
    params.push(invoiceId); params.push(businessId);
    const sql = `UPDATE invoices SET ${updates.join(', ')} WHERE id = ? AND business_id = ?`;
    db.run(sql, params, function(err) {
         if (err) return res.status(500).json({ message: 'Fatura durumu güncellenirken hata.' });
         if (this.changes === 0) return res.status(404).json({ message: 'Güncellenecek fatura bulunamadı.' });
         res.json({ message: `Fatura durumu "${status}" olarak güncellendi.` });
     });
});


// --- Customers ---
app.get('/api/customers', authenticateToken, (req, res) => {
    const businessId = req.user.businessId;
     const { search, isActive, includeBalance } = req.query;
    let sql = `SELECT c.*`; const params = [businessId];
     if (includeBalance === 'true') {
        sql += `, ca.current_balance, ca.updated_at as lastTransactionDate `;
        sql += ` FROM customers c LEFT JOIN customer_accounts ca ON c.id = ca.customer_id AND c.business_id = ca.business_id`;
     } else { sql += ` FROM customers c`; }
     sql += ` WHERE c.business_id = ?`;
    if (search) { sql += ` AND (c.firstName LIKE ? OR c.lastName LIKE ? OR c.phone LIKE ? OR c.company LIKE ?)`; const searchTerm = `%${search}%`; params.push(searchTerm, searchTerm, searchTerm, searchTerm); }
    if (isActive !== undefined) { sql += ` AND c.isActive = ?`; params.push(isActive === 'true' ? 1 : 0); }
    sql += ` ORDER BY c.firstName, c.lastName`;
    db.all(sql, params, (err, rows) => { if (err) return res.status(500).json({ message: 'Müşteriler alınırken veritabanı hatası' }); res.json(rows); });
});

app.get('/api/customers/:id', authenticateToken, (req, res) => {
     const businessId = req.user.businessId; const customerId = req.params.id;
     db.get(`SELECT * FROM customers WHERE id = ? AND business_id = ?`, [customerId, businessId], (err, row) => { if (err) return res.status(500).json({ message: 'Müşteri bilgisi alınırken hata' }); if (!row) return res.status(404).json({ message: 'Müşteri bulunamadı' }); res.json(row); });
 });

app.post('/api/customers', authenticateToken, (req, res) => {
    const businessId = req.user.businessId;
    const { firstName, lastName, phone, district, address, company, taxNo, taxOffice } = req.body;
    const timestamp = getCurrentISOTimestamp();
    if (!firstName || !lastName || !phone) return res.status(400).json({ message: 'Ad, Soyad ve Telefon zorunludur' });
    db.run(`INSERT INTO customers (business_id, firstName, lastName, phone, district, address, company, taxNo, taxOffice, isActive, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
           [businessId, firstName, lastName, phone, district, address, company, taxNo, taxOffice, timestamp, timestamp], function(err) {
        if (err) return res.status(500).json({ message: 'Müşteri oluşturulurken veritabanı hatası' });
        const newCustomerId = this.lastID;
        getOrCreateCustomerAccount(businessId, newCustomerId, (accErr) => { if (accErr) console.error(`Yeni müşteri (ID: ${newCustomerId}) için cari hesap oluşturulamadı:`, accErr); });
        res.status(201).json({ message: 'Müşteri başarıyla oluşturuldu', id: newCustomerId });
    });
});

app.put('/api/customers/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const customerId = req.params.id;
    const { firstName, lastName, phone, district, address, company, taxNo, taxOffice, isActive } = req.body;
    const timestamp = getCurrentISOTimestamp();
    if (firstName === undefined || lastName === undefined || phone === undefined || isActive === undefined) return res.status(400).json({ message: 'Ad, Soyad, Telefon ve Aktiflik durumu zorunludur (veya en azından gönderilmelidir)' });
    const isActiveValue = isActive ? 1 : 0;
    db.run(`UPDATE customers SET firstName = ?, lastName = ?, phone = ?, district = ?, address = ?, company = ?, taxNo = ?, taxOffice = ?, isActive = ?, updated_at = ? WHERE id = ? AND business_id = ?`,
           [firstName, lastName, phone, district, address, company, taxNo, taxOffice, isActiveValue, timestamp, customerId, businessId], function(err) {
        if (err) return res.status(500).json({ message: 'Müşteri güncellenirken veritabanı hatası' });
        if (this.changes === 0) return res.status(404).json({ message: 'Güncellenecek müşteri bulunamadı veya bilgiler aynı' });
        res.json({ message: 'Müşteri başarıyla güncellendi' });
    });
});

app.delete('/api/customers/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const customerId = req.params.id;
    getOrCreateCustomerAccount(businessId, customerId, (err, account) => {
        if (!err && account && account.current_balance !== 0) { return res.status(409).json({ message: `Müşteri silinemez: Cari bakiye (${formatCurrencyForLog(account.current_balance)}) sıfır değil.` }); }
        db.run(`DELETE FROM customers WHERE id = ? AND business_id = ?`, [customerId, businessId], function(err) {
             if (err) return res.status(500).json({ message: 'Müşteri silinirken bir veritabanı hatası oluştu.' });
             if (this.changes === 0) return res.status(404).json({ message: 'Silinecek müşteri bulunamadı.' });
             res.status(200).json({ message: 'Müşteri ve ilişkili cari hesap bilgileri kalıcı olarak silindi.' });
         });
     });
});


// --- Product Groups ---
app.get('/api/product-groups', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { search } = req.query;
    let sql = `SELECT * FROM product_groups WHERE business_id = ?`; const params = [businessId];
    if (search) { sql += ` AND name LIKE ?`; params.push(`%${search}%`); } sql += ` ORDER BY name`;
    db.all(sql, params, (err, rows) => { if (err) return res.status(500).json({ message: 'Ürün grupları alınırken hata' }); res.json(rows); });
});

app.post('/api/product-groups', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'Grup adı zorunludur' });
    const timestamp = getCurrentISOTimestamp();
    db.run(`INSERT INTO product_groups (business_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
           [businessId, name, timestamp, timestamp], function(err) {
        if (err) { if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ message: 'Bu isimde bir grup zaten mevcut' }); return res.status(500).json({ message: 'Grup oluşturulurken hata' }); }
        res.status(201).json({ message: 'Ürün grubu oluşturuldu', id: this.lastID });
    });
});

app.put('/api/product-groups/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const groupId = req.params.id; const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'Grup adı zorunludur' });
    const timestamp = getCurrentISOTimestamp();
    db.run(`UPDATE product_groups SET name = ?, updated_at = ? WHERE id = ? AND business_id = ?`,
           [name, timestamp, groupId, businessId], function(err) {
        if (err) { if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ message: 'Bu isimde başka bir grup zaten mevcut' }); return res.status(500).json({ message: 'Grup güncellenirken hata' }); }
        if (this.changes === 0) return res.status(404).json({ message: 'Grup bulunamadı veya isim aynı' });
        res.json({ message: 'Ürün grubu güncellendi' });
    });
});

app.delete('/api/product-groups/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const groupId = req.params.id;
    db.run(`DELETE FROM product_groups WHERE id = ? AND business_id = ?`, [groupId, businessId], function(err) {
        if (err) return res.status(500).json({ message: 'Grup silinirken veritabanı hatası' });
        if (this.changes === 0) return res.status(404).json({ message: 'Silinecek grup bulunamadı' });
        res.status(200).json({ message: 'Ürün grubu silindi. İlişkili ürünlerin grup bilgisi kaldırıldı.' });
    });
});


// --- Products & Stock ---
app.get('/api/stock', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { search, inStock } = req.query;
    let sql = `SELECT p.*, pg.name as group_name FROM products p LEFT JOIN product_groups pg ON p.group_id = pg.id AND p.business_id = pg.business_id WHERE p.business_id = ?`;
    const params = [businessId];
    if (search) { sql += ` AND (p.name LIKE ? OR pg.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    if (inStock === 'true') { sql += ` AND p.current_stock > 0`; }
    sql += ` ORDER BY p.name`;
    db.all(sql, params, (err, rows) => { if (err) return res.status(500).json({ message: 'Stok bilgisi alınırken hata' }); res.json(rows); });
});

app.post('/api/stock', authenticateToken, (req, res) => {
    const businessId = req.user.businessId;
    const { productName, groupId, quantity, unitCost, supplierId, invoiceRef } = req.body;
    if (!productName || !groupId || !quantity || !Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ message: 'Ürün adı, grup ID ve pozitif tamsayı miktar zorunludur' });
    if (unitCost !== null && unitCost !== undefined && (isNaN(unitCost) || unitCost < 0)) return res.status(400).json({ message: 'Alış fiyatı geçerli bir sayı (0+) olmalı veya null olmalı' });

    // Transaction Başlat: Ürün bul/oluştur, stok ekle, bakiye güncelle
    db.serialize(() => {
        db.run("BEGIN TRANSACTION;", async (beginErr) => {
            if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });

            try {
                // 1. Ürünü bul veya oluştur
                let product = await new Promise((resolve, reject) => {
                    db.get(`SELECT id FROM products WHERE business_id = ? AND lower(name) = lower(?)`, [businessId, productName.toLowerCase()], (err, row) => err ? reject(err) : resolve(row));
                });

                let productId;
                if (product) {
                    productId = product.id;
                } else {
                    const timestamp = getCurrentISOTimestamp();
                    productId = await new Promise((resolve, reject) => {
                         db.run(`INSERT INTO products (business_id, group_id, name, current_stock, last_unit_cost, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
                               [businessId, groupId, productName, unitCost, timestamp, timestamp], function (insertErr) {
                            if (insertErr) { if (insertErr.message.includes('UNIQUE constraint failed')) return reject(new Error('Bu isimde bir ürün zaten mevcut.')); return reject(insertErr); }
                            resolve(this.lastID);
                        });
                    });
                }

                // 2. Stoğu ekle (adjustStock transaction başlatmıyor)
                const movementId = await new Promise((resolve, reject) => {
                     adjustStock(businessId, productId, quantity, 'IN_PURCHASE', unitCost, null, null, null, (stockErr, mId) => stockErr ? reject(stockErr) : resolve(mId));
                });

                // 3. Tedarikçi varsa bakiyeyi güncelle
                let transactionId = null;
                if (supplierId && unitCost !== null && unitCost !== undefined && quantity > 0) {
                    const amountOwed = quantity * unitCost;
                    const description = `Mal Alımı: ${quantity} x ${productName} (${invoiceRef || 'Faturasız'})`;
                    transactionId = await new Promise((resolve, reject) => {
                        updateSupplierBalance(businessId, supplierId, amountOwed, description, invoiceRef, (balanceErr, txId) => balanceErr ? reject(balanceErr) : resolve(txId));
                    });
                }

                 // Opsiyonel: Stok hareketini tedarikçi işlemiyle ilişkilendir (eğer yapıldıysa)
                 // if(transactionId && movementId) { ... }

                // Her şey başarılı, COMMIT et
                db.run("COMMIT;", (commitErr) => {
                    if (commitErr) throw commitErr; // Üstteki catch bloğu yakalar
                     let message = `Ürün bulundu/oluşturuldu ve stok başarıyla eklendi.`;
                     if(transactionId) message += ` Tedarikçi bakiyesi güncellendi.`;
                     res.status(201).json({ message, productId, movementId });
                 });

            } catch (error) { // Üstteki try bloğunun veya Promise reject'lerinin hatası
                console.error("Stok Ekleme/Ürün Oluşturma Hatası:", error);
                db.run("ROLLBACK;");
                res.status(error.message.includes('zaten mevcut') ? 409 : (error.message.includes('bulunamadı') ? 404 : 500))
                   .json({ message: `Stok eklenirken hata: ${error.message}` });
            }
        }); // End Transaction
    }); // End Serialize
});

app.post('/api/stock/adjust', authenticateToken, (req, res) => {
     const businessId = req.user.businessId;
     const { productId, quantityChange, reason } = req.body;
     if (!productId || quantityChange === undefined || !Number.isInteger(quantityChange) || quantityChange === 0) return res.status(400).json({ message: 'Ürün ID ve 0 olmayan tamsayı miktar zorunludur' });
     if (!reason) return res.status(400).json({ message: 'Stok ayarlama nedeni belirtilmelidir' });

     // Transaction başlat
     db.serialize(() => {
        db.run("BEGIN TRANSACTION;", (beginErr) => {
            if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });
            // adjustStock fonksiyonu negatif stok kontrolünü yapar ve işlemi gerçekleştirir
            adjustStock(businessId, productId, quantityChange, 'ADJUST_MANUAL', null, null, null, reason, (err, movementId) => {
                if (err) {
                    db.run("ROLLBACK;");
                    console.error("Manuel stok ayarlama hatası:", err);
                    return res.status(400).json({ message: err.message }); // Yetersiz stok vb.
                }
                db.run("COMMIT;", (commitErr) => {
                     if (commitErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'İşlem kaydedilirken hata (commit)' }); }
                     res.json({ message: `Stok başarıyla ayarlandı. Hareket ID: ${movementId}`, movementId: movementId });
                 });
            });
        });
     });
});


// --- Service Records ---
app.post('/api/service-records/start', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { customerId, plate, km, complaint } = req.body;
    if (!customerId) return res.status(400).json({ message: 'Müşteri ID zorunludur' });
    db.get(`SELECT firstName, lastName FROM customers WHERE id = ? AND business_id = ?`, [customerId, businessId], (err, customer) => {
        if (err || !customer) return res.status(404).json({ message: 'Servis kaydı başlatılacak müşteri bulunamadı' });
        const customerNameSnapshot = `${customer.firstName} ${customer.lastName}`;
        const recordDate = getCurrentISOTimestamp(); const timestamp = recordDate;
        db.run(`INSERT INTO service_records (business_id, customer_id, customerName_snapshot, date, plate, km, complaint, status, created_at, updated_at, vatPercent) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
               [businessId, customerId, customerNameSnapshot, recordDate, plate || null, km || null, complaint || null, timestamp, timestamp, 20], function(err) {
             if (err) return res.status(500).json({ message: 'Servis kaydı başlatılırken veritabanı hatası' });
             res.status(201).json({ message: 'Servis kaydı başarıyla başlatıldı', serviceRecordId: this.lastID });
        });
    });
});

// --- Service Records ---
// ... (diğer service record route'ları) ...

app.post('/api/service-records/:recordId/items', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const serviceRecordId = req.params.recordId;
    // productId'yi de request body'den alıyoruz (frontend null gönderebilir)
    const { type, productId, description, quantity, unitPrice } = req.body;

    // Temel doğrulamalar
    if (!type || (type !== 'Hizmet' && type !== 'Ürün')) return res.status(400).json({ message: 'Geçersiz item tipi' });
    if (!description) return res.status(400).json({ message: 'Açıklama zorunludur' });
    if (!quantity || !Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ message: 'Miktar pozitif tamsayı olmalıdır' });
    if (unitPrice === undefined || isNaN(unitPrice) || unitPrice < 0) return res.status(400).json({ message: 'Birim fiyat 0 veya daha büyük olmalıdır' });
    // productId Ürün tipi için artık zorunlu değil, null olabilir (manuel giriş)

    db.get(`SELECT status FROM service_records WHERE id = ? AND business_id = ?`, [serviceRecordId, businessId], (err, record) => {
        if (err) return res.status(500).json({ message: 'Servis kaydı durumu kontrol edilirken hata' });
        if (!record) return res.status(404).json({ message: 'Servis kaydı bulunamadı' });
        if (record.status !== 'OPEN') return res.status(400).json({ message: 'Sadece "Açık" durumdaki servis kayıtlarına öğe eklenebilir' });

        const total = quantity * unitPrice;
        let costAtTime = null; // Varsayılan olarak null

        // Transaction Başlat: Item ekle + (varsa ve productId verilmişse) Stok düş
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;", (beginErr) => {
                if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });

                // Callback fonksiyonu item eklendikten sonra çağrılacak
                const afterItemAddedCallback = function (insertErr) {
                    if (insertErr) {
                        db.run("ROLLBACK;");
                        console.error("Add Service Item DB error:", insertErr);
                        return res.status(500).json({ message: 'Servis öğesi eklenirken veritabanı hatası' });
                    }
                    const newItemId = this.lastID;

                    // SADECE Ürün tipi ve productId VARSA stok düş
                    if (type === 'Ürün' && productId) {
                        // Stok Azaltma (adjustStock transaction başlatmıyor)
                        adjustStock(businessId, productId, -quantity, 'OUT_SALE', null, newItemId, null, null, (stockErr) => {
                            if (stockErr) {
                                db.run("ROLLBACK;"); // Hata varsa geri al
                                console.warn(`Stok düşme hatası (Item ID: ${newItemId}): ${stockErr.message}`);
                                // Frontend'e stok hatasını gönder
                                return res.status(400).json({ message: stockErr.message });
                            }
                            // Stok düşme başarılı, commit et
                            db.run("COMMIT;", (commitErr) => {
                                if(commitErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'İşlem kaydedilirken hata (commit)' });} // Nadir ama kontrol edelim
                                res.status(201).json({ message: 'Ürün başarıyla eklendi ve stok güncellendi', itemId: newItemId });
                            });
                        });
                    } else { // Hizmet veya Manuel Ürün ise direkt commit (stok düşme yok)
                         db.run("COMMIT;", (commitErr) => {
                             if(commitErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'İşlem kaydedilirken hata (commit)' });} // Nadir ama kontrol edelim
                             const successMessage = type === 'Hizmet' ? 'Hizmet başarıyla eklendi' : 'Manuel ürün başarıyla eklendi (stok etkilenmedi)';
                             res.status(201).json({ message: successMessage, itemId: newItemId });
                         });
                    }
                };

                // Eğer Ürün tipi ve productId VARSA, önce maliyeti al
                if (type === 'Ürün' && productId) {
                    db.get(`SELECT last_unit_cost FROM products WHERE id = ? AND business_id = ?`, [productId, businessId], (prodErr, product) => {
                        if (prodErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'Ürün maliyeti alınırken hata' }); }
                        // ÖNEMLİ: Stoktan ürün seçildiyse ama ürün DB'de yoksa (nadir durum) hata ver
                        if (!product) { db.run("ROLLBACK;"); return res.status(404).json({ message: 'Seçilen ürün veritabanında bulunamadı.' }); }
                        costAtTime = product.last_unit_cost; // Maliyeti ata
                        // Item'ı ekle (maliyet ve productId ile)
                        db.run(`INSERT INTO service_items (business_id, service_record_id, type, product_id, description, quantity, unitPrice, total, cost_at_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                               [businessId, serviceRecordId, type, productId, description, quantity, unitPrice, total, costAtTime, getCurrentISOTimestamp()], afterItemAddedCallback);
                    });
                } else { // Hizmet veya Manuel Ürün ise, maliyet ve productId null olarak ekle
                     db.run(`INSERT INTO service_items (business_id, service_record_id, type, product_id, description, quantity, unitPrice, total, cost_at_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [businessId, serviceRecordId, type, null, description, quantity, unitPrice, total, null, getCurrentISOTimestamp()], afterItemAddedCallback);
                }
            }); // End Transaction
        }); // End Serialize
    }); // End Record Check
});

// ... (diğer route'lar) ...

app.delete('/api/service-records/:recordId/items/:itemId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const serviceRecordId = req.params.recordId; const itemId = req.params.itemId;

    db.get(`SELECT sr.status, si.type, si.product_id, si.quantity FROM service_items si JOIN service_records sr ON si.service_record_id = sr.id WHERE si.id = ? AND si.service_record_id = ? AND si.business_id = ?`,
           [itemId, serviceRecordId, businessId], (err, itemInfo) => {
        if (err) return res.status(500).json({ message: 'Öğe bilgisi alınırken hata' });
        if (!itemInfo) return res.status(404).json({ message: 'Silinecek öğe bulunamadı' });
        if (itemInfo.status !== 'OPEN') return res.status(400).json({ message: 'Sadece "Açık" kayıtlardan öğe silinebilir' });

        db.serialize(() => {
            db.run("BEGIN TRANSACTION;", (beginErr) => {
                 if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });
                 db.run(`DELETE FROM service_items WHERE id = ?`, [itemId], function(deleteErr) {
                     if (deleteErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'Öğe silinirken DB hatası' }); }
                     if (this.changes === 0) { db.run("ROLLBACK;"); return res.status(404).json({ message: 'Silinecek öğe bulunamadı (tekrar?)' }); }

                     if (itemInfo.type === 'Ürün' && itemInfo.product_id && itemInfo.quantity > 0) {
                         adjustStock(businessId, itemInfo.product_id, itemInfo.quantity, 'IN_RETURN', null, itemId, null, 'Servis öğesi silindi', (stockErr) => {
                             if (stockErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: `Öğe silindi ancak stok iadesi yapılamadı: ${stockErr.message}. İşlem geri alındı.` }); }
                             db.run("COMMIT;", (commitErr) => { if(commitErr) return res.status(500).json({ message: 'Commit hatası' }); res.status(200).json({ message: 'Öğe silindi ve stok iade edildi' }); });
                         });
                     } else { db.run("COMMIT;", (commitErr) => { if(commitErr) return res.status(500).json({ message: 'Commit hatası' }); res.status(200).json({ message: 'Hizmet öğesi silindi' }); }); }
                 });
            });
        });
    });
});

app.put('/api/service-records/:recordId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const recordId = req.params.recordId;
    const { plate, km, complaint, status, vatPercent } = req.body; const timestamp = getCurrentISOTimestamp();

    db.get(`SELECT status, customer_id, vatPercent as currentVat FROM service_records WHERE id = ? AND business_id = ?`, [recordId, businessId], (err, record) => {
        if (err) return res.status(500).json({ message: 'Kayıt bilgisi alınırken hata' });
        if (!record) return res.status(404).json({ message: 'Kayıt bulunamadı' });
        const currentStatus = record.status;
        const updates = []; const params = []; let finalize = false;

        if (status) { if (status === 'COMPLETED' && currentStatus === 'OPEN') finalize = true; else if (status !== currentStatus) return res.status(400).json({ message: `Durum '${currentStatus}' iken '${status}' yapılamaz.` }); }
        if (currentStatus === 'OPEN') {
            if (plate !== undefined) { updates.push("plate = ?"); params.push(plate); }
            if (km !== undefined) { updates.push("km = ?"); params.push(km === null ? null : parseInt(km)); }
            if (complaint !== undefined) { updates.push("complaint = ?"); params.push(complaint); }
            if (vatPercent !== undefined && !isNaN(parseFloat(vatPercent)) && parseFloat(vatPercent) >= 0) { updates.push("vatPercent = ?"); params.push(parseFloat(vatPercent)); }
        } else if (!status || status === currentStatus) { if (plate !== undefined || km !== undefined || complaint !== undefined || vatPercent !== undefined) return res.status(400).json({ message: `Kapalı (${currentStatus}) kayıt detayları değiştirilemez.` }); }

        if (updates.length === 0 && !finalize) return res.status(200).json({ message: 'Güncellenecek bilgi yok.' });

        db.serialize(() => { // Transaction başlat (özellikle finalize için)
            db.run("BEGIN TRANSACTION;", (beginErr) => {
                if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });

                const completeUpdate = () => { // Güncellemeyi tamamlayan fonksiyon
                    updates.push("updated_at = ?"); params.push(timestamp);
                    params.push(recordId); params.push(businessId);
                    const whereClause = ` WHERE id = ? AND business_id = ?` + (finalize ? ` AND status = 'OPEN'` : ''); // Finalize sadece açıkken
                    const updateQuery = `UPDATE service_records SET ${updates.join(', ')}${whereClause}`;
                    db.run(updateQuery, params, function(updateErr) {
                         if (updateErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'Kayıt güncellenirken DB hatası' }); }
                         if (this.changes === 0) { db.run("ROLLBACK;"); return res.status(404).json({ message: `Güncellenecek kayıt bulunamadı veya durumu değişmiş.` }); }
                         db.run("COMMIT;", (commitErr) => { if (commitErr) return res.status(500).json({ message: 'Commit hatası' }); res.json({ message: finalize ? 'Kayıt tamamlandı ve bakiye güncellendi' : 'Kayıt detayları güncellendi' }); });
                     });
                };

                if (finalize) {
                    db.all(`SELECT total FROM service_items WHERE service_record_id = ? AND business_id = ?`, [recordId, businessId], (itemErr, items) => {
                        if (itemErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'Toplamlar hesaplanırken hata' }); }
                        if (items.length === 0) { db.run("ROLLBACK;"); return res.status(400).json({ message: 'Boş kayıt tamamlanamaz.' }); }
                        const subtotal = items.reduce((sum, item) => sum + item.total, 0);
                        const finalVatPercent = (vatPercent !== undefined && !isNaN(parseFloat(vatPercent)) && parseFloat(vatPercent) >= 0) ? parseFloat(vatPercent) : (record.currentVat || 0);
                        const vatAmount = subtotal * (finalVatPercent / 100); const grandTotal = subtotal + vatAmount;
                        updates.push("subtotal = ?"); params.push(subtotal);
                        if (!(vatPercent !== undefined && !isNaN(parseFloat(vatPercent)) && parseFloat(vatPercent) >= 0)) { updates.push("vatPercent = ?"); params.push(finalVatPercent); }
                        updates.push("vatAmount = ?"); params.push(vatAmount); updates.push("grandTotal = ?"); params.push(grandTotal); updates.push("status = ?"); params.push('COMPLETED');

                        if (record.customer_id && grandTotal !== 0) {
                            const transactionDesc = `Servis Kaydı #${recordId} Tamamlandı`;
                            updateCustomerBalance(businessId, record.customer_id, grandTotal, transactionDesc, recordId, (balanceErr) => {
                                if (balanceErr) { db.run("ROLLBACK;"); return res.status(207).json({ message: 'Kayıt tamamlandı, ancak bakiye güncellenemedi.' }); }
                                completeUpdate(); // Bakiye güncellendi, ana güncellemeyi yap
                            });
                        } else { completeUpdate(); } // Bakiye güncellemesi gerekmez
                    });
                } else { completeUpdate(); } // Sadece detay güncelleme
            }); // End Transaction
        }); // End Serialize
    }); // End Record Check
});

app.get('/api/service-records', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { page = 1, limit = 10, customerName, plate, status, startDate, endDate } = req.query; const offset = (page - 1) * limit;
    let sqlData = `SELECT sr.id, sr.customerName_snapshot, sr.date, sr.created_at, sr.plate, sr.grandTotal, sr.status, sr.customer_id, c.firstName, c.lastName, inv.id as invoice_id, inv.invoice_number, inv.status as invoice_status FROM service_records sr LEFT JOIN customers c ON sr.customer_id = c.id AND sr.business_id = c.business_id LEFT JOIN invoices inv ON sr.id = inv.service_record_id AND sr.business_id = inv.business_id WHERE sr.business_id = ?`;
    let sqlCount = `SELECT COUNT(*) as count FROM service_records sr WHERE sr.business_id = ?`; const params = [businessId];
    let filterClause = ''; if (customerName) { filterClause += ` AND sr.customerName_snapshot LIKE ?`; params.push(`%${customerName}%`); } if (plate) { filterClause += ` AND sr.plate LIKE ?`; params.push(`%${plate}%`); } if (status) { filterClause += ` AND sr.status = ?`; params.push(status); } if (startDate) { filterClause += ` AND sr.created_at >= ?`; params.push(startDate + 'T00:00:00.000Z'); } if (endDate) { filterClause += ` AND sr.created_at <= ?`; params.push(endDate + 'T23:59:59.999Z'); }
    sqlData += filterClause; sqlCount += filterClause; sqlData += ` ORDER BY sr.created_at DESC LIMIT ? OFFSET ?`; params.push(limit, offset);
    db.get(sqlCount, params.slice(0, -2), (err, countResult) => {
        if (err) return res.status(500).json({ message: 'Kayıt sayısı alınırken hata' }); const totalRecords = countResult.count; const totalPages = Math.ceil(totalRecords / limit);
        db.all(sqlData, params, (err, rows) => { if (err) return res.status(500).json({ message: 'Kayıtlar alınırken hata' }); res.json({ data: rows, pagination: { currentPage: parseInt(page), totalPages: totalPages, totalRecords: totalRecords, limit: parseInt(limit) } }); });
    });
});

app.get('/api/service-records/:recordId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const recordId = req.params.recordId;
    db.get(`SELECT sr.* FROM service_records sr WHERE sr.id = ? AND sr.business_id = ?`, [recordId, businessId], (err, record) => {
        if (err) return res.status(500).json({ message: 'Kayıt alınırken hata' }); if (!record) return res.status(404).json({ message: 'Kayıt bulunamadı' });
        db.all(`SELECT si.* FROM service_items si WHERE si.service_record_id = ? AND si.business_id = ? ORDER BY si.id`, [recordId, businessId], (itemErr, items) => { record.items = itemErr ? [] : (items || []); res.json(record); });
    });
});

app.delete('/api/service-records/:recordId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const recordId = req.params.recordId;
    db.all(`SELECT id, product_id, quantity FROM service_items WHERE service_record_id = ? AND business_id = ? AND type = 'Ürün' AND product_id IS NOT NULL AND quantity > 0`,
           [recordId, businessId], (err, itemsToReturn) => {
        if (err) return res.status(500).json({ message: 'Ürün kontrol hatası' });
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;", (beginErr) => {
                 if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });
                 let stockReturnError = null;
                 const stockReturnPromises = itemsToReturn.map(item => new Promise((resolve, reject) => { adjustStock(businessId, item.product_id, item.quantity, 'IN_RETURN', null, item.id, null, `Servis #${recordId} silindi`, (adjErr) => { if (adjErr) { stockReturnError = adjErr; reject(adjErr); } else resolve(); }); }));
                 Promise.all(stockReturnPromises)
                     .then(() => {
                          db.run(`DELETE FROM service_records WHERE id = ? AND business_id = ?`, [recordId, businessId], function(deleteErr) {
                             if (deleteErr) { db.run("ROLLBACK;"); return res.status(500).json({ message: 'Stok iade edildi ama kayıt silinemedi.' }); }
                             if (this.changes === 0) { db.run("ROLLBACK;"); return res.status(404).json({ message: 'Silinecek kayıt bulunamadı.' }); }
                             db.run("COMMIT;", (commitErr) => { if(commitErr) return res.status(500).json({ message: 'Commit hatası' }); res.status(200).json({ message: 'Kayıt silindi, stoklar iade edildi.' }); });
                         });
                     })
                     .catch((err) => { db.run("ROLLBACK;"); res.status(500).json({ message: `Kayıt silinemedi: Stok iade hatası (${stockReturnError?.message || err.message}).` }); });
            });
        });
    });
});


// --- Customer Accounts (Cari Hesap) ---
app.get('/api/accounts/:customerId', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const customerId = req.params.customerId;
    getOrCreateCustomerAccount(businessId, customerId, (err, account) => {
        if (err) return res.status(500).json({ message: 'Hesap alınırken hata' });
        db.all(`SELECT * FROM customer_transactions WHERE customer_id = ? AND business_id = ? ORDER BY timestamp DESC, id DESC`, [customerId, businessId], (txErr, transactions) => {
            if (txErr) return res.status(500).json({ message: 'Hareketler alınırken hata' });
            res.json({ balance: account.current_balance || 0, transactions: transactions || [] });
        });
    });
});

app.post('/api/accounts/:customerId/transactions', authenticateToken, (req, res) => {
     const businessId = req.user.businessId; const customerId = req.params.customerId; const { amount, description } = req.body;
     if (amount === undefined || isNaN(amount)) return res.status(400).json({ message: 'Geçerli tutar girilmeli' });
     if (!description) return res.status(400).json({ message: 'Açıklama zorunlu' });
     // Transaction Başlat
     db.serialize(() => {
         db.run("BEGIN TRANSACTION;", (beginErr) => {
            if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });
            updateCustomerBalance(businessId, customerId, amount, description, null, (err) => {
                if (err) { db.run("ROLLBACK;"); return res.status(500).json({ message: `İşlem kaydedilemedi: ${err.message}` }); }
                db.run("COMMIT;", (commitErr) => { if(commitErr) return res.status(500).json({ message: 'Commit hatası' }); res.status(201).json({ message: 'Müşteri işlemi kaydedildi' }); });
            });
        });
     });
});


// --- Suppliers ---
app.get('/api/suppliers', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { search, includeBalance } = req.query;
    let sql = `SELECT s.*`; const params = [businessId];
    if (includeBalance === 'true') { sql += `, sa.current_balance `; sql += ` FROM suppliers s LEFT JOIN supplier_accounts sa ON s.id = sa.supplier_id AND s.business_id = sa.business_id`; } else { sql += ` FROM suppliers s`; }
    sql += ` WHERE s.business_id = ?`;
    if (search) { sql += ` AND (s.name LIKE ? OR s.contact_person LIKE ? OR s.phone LIKE ?)`; const searchTerm = `%${search}%`; params.push(searchTerm, searchTerm, searchTerm); } sql += ` ORDER BY s.name`;
    db.all(sql, params, (err, rows) => { if (err) return res.status(500).json({ message: 'Tedarikçiler alınırken hata' }); res.json(rows); });
});

app.get('/api/suppliers/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const supplierId = req.params.id;
    db.get(`SELECT * FROM suppliers WHERE id = ? AND business_id = ?`, [supplierId, businessId], (err, row) => { if (err) return res.status(500).json({ message: 'Tedarikçi bilgisi alınırken hata' }); if (!row) return res.status(404).json({ message: 'Tedarikçi bulunamadı' }); res.json(row); });
});

app.post('/api/suppliers', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { name, contact_person, phone, email, address, taxNo, taxOffice } = req.body;
    if (!name) return res.status(400).json({ message: 'Tedarikçi adı zorunludur' }); const timestamp = getCurrentISOTimestamp();
    db.run(`INSERT INTO suppliers (business_id, name, contact_person, phone, email, address, taxNo, taxOffice, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
           [businessId, name, contact_person, phone, email, address, taxNo, taxOffice, timestamp, timestamp], function(err) {
        if (err) { if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ message: 'Bu isimde bir tedarikçi zaten mevcut' }); return res.status(500).json({ message: 'Tedarikçi oluşturulurken hata' }); }
        const newSupplierId = this.lastID; getOrCreateSupplierAccount(businessId, newSupplierId, (accErr) => { if (accErr) console.error(`Yeni tedarikçi (ID: ${newSupplierId}) için hesap oluşturulamadı:`, accErr); });
        res.status(201).json({ message: 'Tedarikçi oluşturuldu', id: newSupplierId });
    });
});

app.put('/api/suppliers/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const supplierId = req.params.id; const { name, contact_person, phone, email, address, taxNo, taxOffice } = req.body;
    if (!name) return res.status(400).json({ message: 'Tedarikçi adı zorunludur' }); const timestamp = getCurrentISOTimestamp();
    db.run(`UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, taxNo = ?, taxOffice = ?, updated_at = ? WHERE id = ? AND business_id = ?`,
           [name, contact_person, phone, email, address, taxNo, taxOffice, timestamp, supplierId, businessId], function(err) {
        if (err) { if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ message: 'Bu isimde başka bir tedarikçi zaten mevcut' }); return res.status(500).json({ message: 'Tedarikçi güncellenirken hata' }); }
        if (this.changes === 0) return res.status(404).json({ message: 'Tedarikçi bulunamadı veya bilgiler aynı' }); res.json({ message: 'Tedarikçi güncellendi' });
    });
});

app.delete('/api/suppliers/:id', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const supplierId = req.params.id;
     getOrCreateSupplierAccount(businessId, supplierId, (err, account) => {
        if (!err && account && account.current_balance !== 0) { return res.status(409).json({ message: `Tedarikçi silinemez: Bakiye (${formatCurrencyForLog(account.current_balance)}) sıfır değil.` }); }
        db.run(`DELETE FROM suppliers WHERE id = ? AND business_id = ?`, [supplierId, businessId], function(err) {
            if (err) return res.status(500).json({ message: 'Tedarikçi silinirken veritabanı hatası' });
            if (this.changes === 0) return res.status(404).json({ message: 'Silinecek tedarikçi bulunamadı' });
            res.json({ message: 'Tedarikçi ve ilişkili hesap bilgileri kalıcı olarak silindi.' });
        });
     });
});


// --- Supplier Accounts ---
app.get('/api/suppliers/:supplierId/account', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const supplierId = req.params.supplierId;
    getOrCreateSupplierAccount(businessId, supplierId, (err, account) => {
        if (err) return res.status(500).json({ message: 'Tedarikçi hesabı alınırken hata' });
        db.all(`SELECT * FROM supplier_transactions WHERE supplier_id = ? AND business_id = ? ORDER BY timestamp DESC, id DESC`, [supplierId, businessId], (txErr, transactions) => {
            if (txErr) return res.status(500).json({ message: 'Tedarikçi hareketleri alınırken hata' });
            res.json({ balance: account.current_balance || 0, transactions: transactions || [] });
        });
    });
});

app.post('/api/suppliers/:supplierId/transactions', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const supplierId = req.params.supplierId; const { amount, description, invoiceRef } = req.body;
    if (amount === undefined || isNaN(amount)) return res.status(400).json({ message: 'Geçerli tutar girilmeli' });
    if (!description) return res.status(400).json({ message: 'Açıklama zorunlu' });
    // Transaction Başlat
    db.serialize(() => {
        db.run("BEGIN TRANSACTION;", (beginErr) => {
            if(beginErr) return res.status(500).json({ message: 'DB transaction başlatılamadı' });
            updateSupplierBalance(businessId, supplierId, amount, description, invoiceRef || null, (err, transactionId) => {
                if (err) { db.run("ROLLBACK;"); return res.status(500).json({ message: `İşlem kaydedilemedi: ${err.message}` }); }
                db.run("COMMIT;", (commitErr) => { if(commitErr) return res.status(500).json({ message: 'Commit hatası' }); res.status(201).json({ message: 'Tedarikçi işlemi kaydedildi', transactionId: transactionId }); });
            });
        });
    });
});


// --- Reports ---
app.get('/api/reports/profit-loss', authenticateToken, (req, res) => {
    const businessId = req.user.businessId; const { startDate, endDate } = req.query;
    let salesQuery = `SELECT SUM(grandTotal) as totalSales FROM service_records WHERE status = 'COMPLETED' AND business_id = ?`; const salesParams = [businessId];
    if (startDate) { salesQuery += ` AND date >= ?`; salesParams.push(startDate + 'T00:00:00.000Z'); } if (endDate) { salesQuery += ` AND date <= ?`; salesParams.push(endDate + 'T23:59:59.999Z'); }
    let cogsQuery = `SELECT SUM(si.quantity * si.cost_at_time) as totalCOGS FROM service_items si JOIN service_records sr ON si.service_record_id = sr.id WHERE si.type = 'Ürün' AND si.cost_at_time IS NOT NULL AND si.business_id = ? AND sr.status = 'COMPLETED'`; const cogsParams = [businessId];
    if (startDate) { cogsQuery += ` AND sr.date >= ?`; cogsParams.push(startDate + 'T00:00:00.000Z'); } if (endDate) { cogsQuery += ` AND sr.date <= ?`; cogsParams.push(endDate + 'T23:59:59.999Z'); }
    db.get(salesQuery, salesParams, (err, salesResult) => {
        if (err) return res.status(500).json({ message: 'Satışlar hesaplanırken hata' }); const totalSales = salesResult?.totalSales || 0;
        db.get(cogsQuery, cogsParams, (cogsErr, cogsResult) => {
             if (cogsErr) return res.status(500).json({ message: 'SMM hesaplanırken hata' }); const totalCOGS = cogsResult?.totalCOGS || 0; const grossProfit = totalSales - totalCOGS;
             res.json({ totalSales: totalSales, totalCOGS: totalCOGS, grossProfit: grossProfit, filters: { startDate, endDate } });
        });
    });
});


// --- Sunucuyu Başlatma ve Kapatma ---
const server = app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor (cPanel Environment)`); // Log mesajını güncelleyebilirsiniz
});