require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads_fesindico (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL,
        cnpj TEXT,
        cnpj_encontrado BOOLEAN,
        nome_empresa TEXT,
        cidade TEXT,
        nome_contato TEXT,
        whatsapp TEXT,
        telefone TEXT,
        email TEXT,
        segmento TEXT,
        produtos JSONB DEFAULT '[]',
        oportunidade TEXT,
        urgencia TEXT,
        atualizar_dados BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Base de CNPJ ativos da Ferreira Costa (MAXXON.CLIE — 159.225
    // registros) — usada só pra identificar, na hora, se quem está
    // respondendo já é cliente cadastrado. Foto estática (não é ligação ao
    // vivo com o Oracle, que não é alcançável fora da rede FC).
    // DELIBERADAMENTE não versionada no repo (é uma exportação real de
    // clientes da FC, e este repo é público no GitHub) — importada uma vez
    // via POST /api/admin/importar-cnpjs (protegido por CNPJ_IMPORT_TOKEN).
    await pool.query(`CREATE TABLE IF NOT EXISTS cnpjs_fc (cnpj TEXT PRIMARY KEY)`);

    console.log('Tabelas prontas.');
  } catch (err) {
    console.error('Erro ao inicializar banco:', err.message);
  }
}
initDB();

// Importação protegida da base de CNPJ (rodar uma vez, manualmente, logo
// após o primeiro deploy — ver CNPJ_IMPORT_TOKEN nas variáveis de ambiente
// do Render). Aceita lotes (o chamador decide o tamanho) pra não estourar
// o limite de payload; pode ser chamada várias vezes, é idempotente
// (ON CONFLICT DO NOTHING).
app.post('/api/admin/importar-cnpjs', async (req, res) => {
  try {
    const token = req.headers['x-import-token'];
    if (!process.env.CNPJ_IMPORT_TOKEN || token !== process.env.CNPJ_IMPORT_TOKEN) {
      return res.status(403).json({ error: 'Token inválido.' });
    }
    const lista = Array.isArray(req.body.cnpjs) ? req.body.cnpjs.map(String).map(s => s.replace(/\D/g, '')).filter(s => s.length === 14) : [];
    if (!lista.length) return res.status(400).json({ error: 'Envie { cnpjs: ["14 digitos", ...] }.' });
    const valores = lista.map((_, i) => `($${i + 1})`).join(',');
    await pool.query(`INSERT INTO cnpjs_fc (cnpj) VALUES ${valores} ON CONFLICT DO NOTHING`, lista);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS qtd FROM cnpjs_fc');
    res.json({ ok: true, recebidos: lista.length, totalNaBase: rows[0].qtd });
  } catch (err) {
    console.error('POST importar-cnpjs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cnpj-existe/:cnpj', async (req, res) => {
  try {
    const cnpj = String(req.params.cnpj || '').replace(/\D/g, '');
    if (cnpj.length !== 14) return res.json({ existe: false });
    const r = await pool.query('SELECT 1 FROM cnpjs_fc WHERE cnpj = $1', [cnpj]);
    res.json({ existe: r.rows.length > 0 });
  } catch (err) {
    console.error('GET cnpj-existe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads-fesindico', async (req, res) => {
  try {
    const {
      tipo, cnpj, cnpjEncontrado, nomeEmpresa, cidade,
      nomeContato, whatsapp, telefone, email, segmento,
      produtos, oportunidade, urgencia, atualizarDados
    } = req.body;
    if (tipo !== 'novo' && tipo !== 'recorrente') {
      return res.status(400).json({ error: 'Campo "tipo" deve ser "novo" ou "recorrente".' });
    }
    const result = await pool.query(
      `INSERT INTO leads_fesindico
       (tipo, cnpj, cnpj_encontrado, nome_empresa, cidade, nome_contato,
        whatsapp, telefone, email, segmento, produtos, oportunidade, urgencia, atualizar_dados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       RETURNING id`,
      [
        tipo, cnpj || null, cnpjEncontrado === undefined ? null : !!cnpjEncontrado,
        nomeEmpresa || null, cidade || null, nomeContato || null,
        whatsapp || null, telefone || null, email || null, segmento || null,
        JSON.stringify(Array.isArray(produtos) ? produtos : []),
        oportunidade || null, urgencia || null,
        atualizarDados === undefined ? null : !!atualizarDados
      ]
    );
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('POST leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export simples dos leads capturados, protegido pelo mesmo token de
// importação — usado pra puxar os dados depois do evento (Excel/CRM).
app.get('/api/admin/leads-fesindico', async (req, res) => {
  try {
    const token = req.headers['x-import-token'];
    if (!process.env.CNPJ_IMPORT_TOKEN || token !== process.env.CNPJ_IMPORT_TOKEN) {
      return res.status(403).json({ error: 'Token inválido.' });
    }
    const r = await pool.query('SELECT * FROM leads_fesindico ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) {
    console.error('GET leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
