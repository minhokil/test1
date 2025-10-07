const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

const app = express();
const port = 3000;

// 데이터베이스 설정
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('데이터베이스 연결 오류:', err.message);
    } else {
        console.log('SQLite 데이터베이스에 성공적으로 연결되었습니다.');
        initializeDb();
    }
});

// 테이블 초기화 함수
function initializeDb() {
    db.serialize(() => {
        // 계약 정보를 저장하는 테이블 (current_pdf_name 추가)
        db.run(`CREATE TABLE IF NOT EXISTS contracts (
            id TEXT PRIMARY KEY,
            original_pdf_name TEXT NOT NULL,
            current_pdf_name TEXT,
            status TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error('contracts 테이블 생성 오류:', err.message);
            else console.log('contracts 테이블이 성공적으로 준비되었습니다.');
        });

        // 각 계약에 속한 입력 필드 정보를 저장하는 테이블
        db.run(`CREATE TABLE IF NOT EXISTS fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id TEXT NOT NULL,
            type TEXT NOT NULL, -- 'text', 'seal', 'student_sign', 'parent_sign'
            x REAL NOT NULL,
            y REAL NOT NULL,
            width REAL NOT NULL,
            height REAL NOT NULL,
            value TEXT, -- 기업이 입력한 텍스트 값 또는 서명/직인 이미지 파일 경로
            FOREIGN KEY (contract_id) REFERENCES contracts (id)
        )`, (err) => {
            if (err) console.error('fields 테이블 생성 오류:', err.message);
            else console.log('fields 테이블이 성공적으로 준비되었습니다.');
        });
    });
}

// 미들웨어 설정
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: storage });

// --- API Routes ---

// 1. 계약 생성 (PDF 업로드)
app.post('/api/contracts', upload.single('agreement'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('PDF 파일이 필요합니다.');
    }

    const contractId = `contract-${Date.now()}`;
    const originalPdfName = req.file.filename;
    const status = 'pending_fields';

    const sql = `INSERT INTO contracts (id, original_pdf_name, current_pdf_name, status) VALUES (?, ?, ?, ?)`;
    db.run(sql, [contractId, originalPdfName, originalPdfName, status], function(err) {
        if (err) {
            console.error('계약 정보 저장 오류:', err.message);
            return res.status(500).send('서버 오류가 발생했습니다.');
        }
        console.log(`새 계약이 생성되었습니다. ID: ${contractId}`);
        res.redirect(`/field-setter.html?id=${contractId}`);
    });
});

// 2. 특정 계약 정보 조회 (+ 필드 정보 포함)
app.get('/api/contracts/:id', (req, res) => {
    const contractId = req.params.id;
    const sqlContract = `SELECT * FROM contracts WHERE id = ?`;

    db.get(sqlContract, [contractId], (err, contract) => {
        if (err) {
            console.error('계약 정보 조회 오류:', err.message);
            return res.status(500).json({ success: false, message: '서버 오류' });
        }
        if (!contract) {
            return res.status(404).json({ success: false, message: '계약을 찾을 수 없습니다.' });
        }

        const sqlFields = `SELECT * FROM fields WHERE contract_id = ? ORDER BY id`;
        db.all(sqlFields, [contractId], (err, fields) => {
            if (err) {
                console.error('필드 정보 조회 오류:', err.message);
                return res.status(500).json({ success: false, message: '서버 오류' });
            }
            contract.fields = fields || [];
            res.json({ success: true, contract });
        });
    });
});

// 3. 필드 정보 저장
app.post('/api/fields', (req, res) => {
    const { contractId, fields } = req.body;

    if (!contractId || !fields || !Array.isArray(fields)) {
        return res.status(400).json({ success: false, message: '잘못된 요청 데이터입니다.' });
    }

    db.serialize(() => {
        // 트랜잭션 시작
        db.run('BEGIN TRANSACTION');

        // 기존 필드 삭제
        const deleteSql = `DELETE FROM fields WHERE contract_id = ?`;
        db.run(deleteSql, [contractId]);

        // 새 필드 삽입
        const insertSql = `INSERT INTO fields (contract_id, type, x, y, width, height) VALUES (?, ?, ?, ?, ?, ?)`;
        const stmt = db.prepare(insertSql);
        fields.forEach(f => {
            stmt.run(contractId, f.type, f.x, f.y, f.width, f.height);
        });
        stmt.finalize();

        // 계약 상태 업데이트
        const updateSql = `UPDATE contracts SET status = 'pending_company_input' WHERE id = ?`;
        db.run(updateSql, [contractId]);

        // 트랜잭션 커밋
        db.run('COMMIT', (err) => {
            if (err) {
                db.run('ROLLBACK');
                console.error('필드 저장 트랜잭션 오류:', err.message);
                return res.status(500).json({ success: false, message: '필드 저장 중 오류 발생' });
            }
            console.log(`Contract ID ${contractId}의 필드가 성공적으로 저장되었습니다.`);
            const companyLink = `${req.protocol}://${req.get('host')}/company-form.html?id=${contractId}`;
            console.log(`[KAKAOTALK_SIMULATION] 기업 담당자에게 링크 전송: ${companyLink}`);
            res.json({ success: true, message: '필드가 성공적으로 저장되었습니다.' });
        });
    });
});

// 4. 기업 정보 입력 및 PDF 수정
app.post('/api/company-input', upload.any(), async (req, res) => {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ success: false, message: "계약 ID가 없습니다." });

    try {
        // 1. 계약 및 필드 정보 조회
        const contract = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM contracts WHERE id = ?`, [contractId], (err, row) => err ? reject(err) : resolve(row));
        });
        const fields = await new Promise((resolve, reject) => {
            db.all(`SELECT * FROM fields WHERE contract_id = ?`, [contractId], (err, rows) => err ? reject(err) : resolve(rows));
        });

        if (!contract) return res.status(404).json({ success: false, message: "계약을 찾을 수 없습니다." });

        // 2. PDF 파일 로드
        const pdfPath = path.join(__dirname, 'uploads', contract.current_pdf_name);
        const pdfBytes = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const page = pdfDoc.getPages()[0];

        const dbUpdates = [];

        // 3. 필드 값 처리 및 PDF 수정
        for (const field of fields) {
            const fieldName = `field_${field.id}`;

            if (field.type === 'text' && req.body[fieldName]) {
                const text = req.body[fieldName];
                page.drawText(text, {
                    x: field.x,
                    y: page.getHeight() - field.y - field.height, // pdf-lib는 좌측 하단이 원점
                    size: 10,
                    // 폰트 미지정시 기본 폰트 사용. 한글 깨짐 이슈 발생 가능.
                });
                dbUpdates.push(new Promise(r => db.run(`UPDATE fields SET value = ? WHERE id = ?`, [text, field.id], r)));

            } else if (field.type === 'seal') {
                const file = req.files.find(f => f.fieldname === fieldName);
                if (file) {
                    const imgBytes = fs.readFileSync(file.path);
                    const image = await (file.mimetype === 'image/png' ? pdfDoc.embedPng(imgBytes) : pdfDoc.embedJpg(imgBytes));
                    page.drawImage(image, {
                        x: field.x,
                        y: page.getHeight() - field.y - field.height,
                        width: field.width,
                        height: field.height,
                    });
                    dbUpdates.push(new Promise(r => db.run(`UPDATE fields SET value = ? WHERE id = ?`, [file.filename, field.id], r)));
                }
            }
        }

        // 4. 수정된 PDF 저장
        const newPdfBytes = await pdfDoc.save();
        const newPdfName = `${contract.id}-company-signed.pdf`;
        fs.writeFileSync(path.join(__dirname, 'uploads', newPdfName), newPdfBytes);

        // 5. 데이터베이스 업데이트
        await Promise.all(dbUpdates);
        await new Promise(r => db.run(`UPDATE contracts SET current_pdf_name = ?, status = 'pending_signatures' WHERE id = ?`, [newPdfName, contractId], r));

        console.log(`Contract ID ${contractId}가 기업에 의해 서명되고 PDF가 업데이트되었습니다.`);
        const signatureLink = `${req.protocol}://${req.get('host')}/signature-form.html?id=${contractId}`;
        console.log(`[KAKAOTALK_SIMULATION] 학생/학부모에게 링크 전송: ${signatureLink}`);
        res.json({ success: true, message: '성공적으로 제출되었습니다.' });

    } catch (error) {
        console.error('기업 정보 처리 중 오류:', error);
        res.status(500).json({ success: false, message: '서버 처리 중 오류가 발생했습니다.' });
    }
});

// 6. 모든 계약 목록 조회
app.get('/api/contracts', (req, res) => {
    const sql = `SELECT * FROM contracts ORDER BY created_at DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('모든 계약 조회 오류:', err.message);
            return res.status(500).json({ success: false, message: '서버 오류' });
        }
        res.json({ success: true, contracts: rows });
    });
});

// 7. 계약 승인/반려 처리
app.post('/api/contracts/:id/action', (req, res) => {
    const { id } = req.params;
    const { action } = req.body; // 'approve' or 'reject'

    if (action === 'approve') {
        const sql = `UPDATE contracts SET status = 'approved' WHERE id = ?`;
        db.run(sql, [id], function(err) {
            if (err) {
                console.error('계약 승인 오류:', err.message);
                return res.status(500).json({ success: false, message: '서버 오류' });
            }
            console.log(`[KAKAOTALK_SIMULATION] 계약 ${id}이 최종 승인되었음을 모든 관련자에게 알림.`);
            res.json({ success: true, message: '계약이 승인되었습니다.' });
        });

    } else if (action === 'reject') {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            const updateContractSql = `
                UPDATE contracts
                SET status = 'rejected', current_pdf_name = original_pdf_name
                WHERE id = ?`;
            db.run(updateContractSql, [id]);

            const resetFieldsSql = `UPDATE fields SET value = NULL WHERE contract_id = ?`;
            db.run(resetFieldsSql, [id]);

            db.run('COMMIT', (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    console.error('계약 반려 처리 오류:', err.message);
                    return res.status(500).json({ success: false, message: '서버 오류' });
                }
                const companyLink = `${req.protocol}://${req.get('host')}/company-form.html?id=${id}`;
                console.log(`[KAKAOTALK_SIMULATION] 계약 ${id}이 반려되었음을 기업 담당자에게 알림. 재작성 링크: ${companyLink}`);
                res.json({ success: true, message: '계약이 반려처리 되었습니다.' });
            });
        });

    } else {
        res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    }
});

// 5. 학생/학부모 서명 및 최종 PDF 생성
app.post('/api/signatures', async (req, res) => {
    const { contractId, studentSignature, parentSignature } = req.body;
    if (!contractId || !studentSignature || !parentSignature) {
        return res.status(400).json({ success: false, message: "모든 서명 데이터가 필요합니다." });
    }

    try {
        // 1. 계약 및 필드 정보 조회
        const contract = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM contracts WHERE id = ?`, [contractId], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!contract) return res.status(404).json({ success: false, message: "계약을 찾을 수 없습니다." });

        const studentSignField = await new Promise((r,j) => db.get(`SELECT * FROM fields WHERE contract_id = ? AND type = 'student_sign'`, [contractId], (e, row) => e ? j(e) : r(row)));
        const parentSignField = await new Promise((r,j) => db.get(`SELECT * FROM fields WHERE contract_id = ? AND type = 'parent_sign'`, [contractId], (e, row) => e ? j(e) : r(row)));

        // 2. PDF 파일 로드
        const pdfPath = path.join(__dirname, 'uploads', contract.current_pdf_name);
        const pdfDoc = await PDFDocument.load(fs.readFileSync(pdfPath));
        const page = pdfDoc.getPages()[0];
        const dbUpdates = [];

        // 3. 서명 이미지 처리 및 PDF에 삽입
        const signatures = [
            { type: 'student', data: studentSignature, field: studentSignField },
            { type: 'parent', data: parentSignature, field: parentSignField }
        ];

        for (const sig of signatures) {
            if (sig.field) {
                const base64Data = sig.data.replace(/^data:image\/png;base64,/, "");
                const fileName = `${contract.id}-${sig.type}-signature.png`;
                fs.writeFileSync(path.join(__dirname, 'uploads', fileName), base64Data, 'base64');

                const imageBytes = fs.readFileSync(path.join(__dirname, 'uploads', fileName));
                const image = await pdfDoc.embedPng(imageBytes);

                page.drawImage(image, {
                    x: sig.field.x,
                    y: page.getHeight() - sig.field.y - sig.field.height,
                    width: sig.field.width,
                    height: sig.field.height,
                });
                dbUpdates.push(new Promise(r => db.run(`UPDATE fields SET value = ? WHERE id = ?`, [fileName, sig.field.id], r)));
            }
        }

        // 4. 최종 PDF 저장
        const newPdfBytes = await pdfDoc.save();
        const finalPdfName = `${contract.id}-final.pdf`;
        fs.writeFileSync(path.join(__dirname, 'uploads', finalPdfName), newPdfBytes);

        // 5. DB 업데이트
        await Promise.all(dbUpdates);
        await new Promise(r => db.run(`UPDATE contracts SET current_pdf_name = ?, status = 'completed' WHERE id = ?`, [finalPdfName, contractId], r));

        console.log(`Contract ID ${contractId}의 최종 서명이 완료되고 PDF가 생성되었습니다.`);
        res.json({ success: true, message: '최종 서명이 완료되었습니다.' });

    } catch (error) {
        console.error('최종 서명 처리 중 오류:', error);
        res.status(500).json({ success: false, message: '서버 처리 중 오류가 발생했습니다.' });
    }
});


// --- Page Routes ---

// 기본 라우트
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 서버 시작
app.listen(port, () => {
    console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
});