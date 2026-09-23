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
    // 22/09/2026, pedido do Victor: pergunta nova no fluxo de cadastro
    // (também novo/sem cadastro) — "você está em obra no momento?".
    // ADD COLUMN IF NOT EXISTS é idempotente, seguro rodar toda vez.
    await pool.query(`ALTER TABLE leads_fesindico ADD COLUMN IF NOT EXISTS em_obra BOOLEAN`);

    // Base de CNPJ ativos da Ferreira Costa (MAXXON.CLIE — 159.225
    // registros) — usada só pra identificar, na hora, se quem está
    // respondendo já é cliente cadastrado. Foto estática (não é ligação ao
    // vivo com o Oracle, que não é alcançável fora da rede FC).
    // DELIBERADAMENTE não versionada no repo (é uma exportação real de
    // clientes da FC, e este repo é público no GitHub) — importada uma vez
    // via POST /api/admin/importar-cnpjs (protegido por CNPJ_IMPORT_TOKEN).
    await pool.query(`CREATE TABLE IF NOT EXISTS cnpjs_fc (cnpj TEXT PRIMARY KEY)`);

    // 23/09/2026, pedido do Victor: sorteio de 1 cadastrado por dia
    // (25 e 26/09/2026), direto no painel admin — registra cada sorteio
    // pra não perder o histórico entre deploys/restart do serviço.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sorteios_realizados (
        id SERIAL PRIMARY KEY,
        dia TEXT NOT NULL,
        pool_size INT NOT NULL,
        vencedor_id INT NOT NULL,
        vencedor_nome TEXT,
        vencedor_empresa TEXT,
        vencedor_cnpj TEXT,
        vencedor_whatsapp TEXT,
        sorteado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

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
      produtos, oportunidade, urgencia, atualizarDados, emObra
    } = req.body;
    if (tipo !== 'novo' && tipo !== 'recorrente') {
      return res.status(400).json({ error: 'Campo "tipo" deve ser "novo" ou "recorrente".' });
    }
    const result = await pool.query(
      `INSERT INTO leads_fesindico
       (tipo, cnpj, cnpj_encontrado, nome_empresa, cidade, nome_contato,
        whatsapp, telefone, email, segmento, produtos, oportunidade, urgencia, atualizar_dados, em_obra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
       RETURNING id`,
      [
        tipo, cnpj || null, cnpjEncontrado === undefined ? null : !!cnpjEncontrado,
        nomeEmpresa || null, cidade || null, nomeContato || null,
        whatsapp || null, telefone || null, email || null, segmento || null,
        JSON.stringify(Array.isArray(produtos) ? produtos : []),
        oportunidade || null, urgencia || null,
        atualizarDados === undefined ? null : !!atualizarDados,
        emObra === undefined ? null : !!emObra
      ]
    );
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('POST leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export simples dos leads capturados, protegido pelo mesmo token de
// importação — usado pra puxar os dados depois do evento (Excel/CRM), e
// também pela sincronização incremental do HUB pro Oracle BIFC (22/09/2026,
// ver fesindicoPuxarLeadsDoServicoPublico() em hub-tradx-deploy/api/server.js
// — ?desdeId= filtra só leads novos, mesmo padrão já usado pro QR Code).
app.get('/api/admin/leads-fesindico', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const desdeId = Number(req.query.desdeId);
    const r = Number.isInteger(desdeId) && desdeId > 0
      ? await pool.query('SELECT * FROM leads_fesindico WHERE id > $1 ORDER BY id ASC', [desdeId])
      : await pool.query('SELECT * FROM leads_fesindico ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) {
    console.error('GET leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 23/09/2026, achado do Coringa (repositório é PÚBLICO no GitHub): o
// CNPJ_IMPORT_TOKEN também dá acesso a POST /api/admin/importar-cnpjs (que
// sobrescreve a base de 159 mil CNPJs reais da FC) — não deveria ser o
// mesmo valor hardcoded no admin.html (JS client-side, fica visível pra
// quem abrir o "ver código-fonte" e, pior, vai parar no histórico do Git
// público assim que commitado). ADMIN_TOKEN é um valor novo, mais fraco,
// só pra essas rotas (leitura de leads, edição/exclusão pontual, sorteio)
// — CNPJ_IMPORT_TOKEN continua funcionando aqui também (superset), mas
// importar-cnpjs (a rota mais perigosa) segue aceitando só o token forte,
// nunca o ADMIN_TOKEN (ver checagem própria dela, não usa esta função).
function checarTokenAdmin(req, res) {
  const token = req.headers['x-import-token'];
  const valido = !!token && (token === process.env.CNPJ_IMPORT_TOKEN || (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN));
  if (!valido) {
    res.status(403).json({ error: 'Token inválido.' });
    return false;
  }
  return true;
}

// Edição/exclusão de cadastros pelo painel admin — mesmo token de acesso
// (22/09/2026, pedido do Victor: limpar os cadastros fictícios de teste e
// corrigir dados errados direto pela plataforma).
const CAMPOS_EDITAVEIS = [
  'nome_empresa', 'cnpj', 'cidade', 'nome_contato', 'whatsapp', 'telefone',
  'email', 'segmento', 'oportunidade', 'urgencia', 'em_obra', 'atualizar_dados'
];
app.put('/api/admin/leads-fesindico/:id', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
    const sets = [];
    const valores = [];
    CAMPOS_EDITAVEIS.forEach((campo) => {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
        valores.push(req.body[campo]);
        sets.push(`${campo} = $${valores.length}`);
      }
    });
    if (!sets.length) return res.status(400).json({ error: 'Nenhum campo pra atualizar.' });
    valores.push(id);
    const r = await pool.query(
      `UPDATE leads_fesindico SET ${sets.join(', ')} WHERE id = $${valores.length} RETURNING *`,
      valores
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cadastro não encontrado.' });
    res.json({ ok: true, lead: r.rows[0] });
  } catch (err) {
    console.error('PUT leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/admin/leads-fesindico/:id', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
    const r = await pool.query('DELETE FROM leads_fesindico WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cadastro não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 23/09/2026, pedido do Victor: sorteio de 1 cadastrado por dia (25 e
// 26/09/2026), entre todos os cadastros feitos até aquele momento — direto
// no painel admin (mesmo token), sem depender de nenhum outro serviço.
// Filtra cadastros de teste automaticamente (padrão, não ID fixo, porque
// mais testes podem aparecer até o dia do sorteio).
function ehCadastroTeste(l) {
  const campos = [l.nome_empresa, l.nome_contato, l.cidade, l.cnpj, l.email].filter(Boolean).join(' ').toUpperCase();
  if (campos.includes('TESTE')) return true;
  if (l.cnpj && /^(\d)\1{13}$/.test(l.cnpj)) return true; // todos os dígitos iguais
  return false;
}
// 23/09/2026, pedido do Victor: ninguém pode ganhar 2 vezes — nem no
// mesmo dia (clicando "Sortear de novo"), nem em dias diferentes (25 e
// 26/09) — exclui do pool qualquer ID que já apareça em sorteios_realizados,
// de qualquer dia anterior (não só do dia atual).
//
// 23/09/2026, 2º pedido: cada pessoa só concorre no dia em que se
// cadastrou — o pool NÃO é mais cumulativo entre os 2 dias de sorteio.
// Exceção: o dia 25 (1º dia de sorteio) também inclui quem se cadastrou
// no dia 24 (a feira já tinha começado, mas ainda não tinha sorteio) —
// pra esses cadastros não ficarem sem chance nenhuma. Do dia 26 em diante,
// cada dia é uma janela fechada (só aquele dia, sem herdar do anterior).
const PRIMEIRO_DIA_SORTEIO = '2026-09-25';
async function montarPoolSorteio(dia) {
  // 23/09/2026, achado do Coringa: "<= 23:59:59" deixava uma brecha de
  // menos de 1s (23:59:59.001 a 23:59:59.999) que não batia em NENHUM dos
  // 2 filtros — trocado pro início do dia SEGUINTE, exclusivo ("<"), que
  // cobre o segundo inteiro sem brecha nenhuma.
  const [ano, mes, diaNum] = dia.split('-').map(Number);
  const proximoDia = new Date(Date.UTC(ano, mes - 1, diaNum + 1));
  const fimExclusivo = proximoDia.toISOString().slice(0, 10) + 'T00:00:00-03:00';
  const params = [fimExclusivo];
  let filtroData = 'created_at < $1::timestamptz';
  if (dia !== PRIMEIRO_DIA_SORTEIO) {
    params.push(`${dia}T00:00:00-03:00`);
    filtroData = 'created_at < $1::timestamptz AND created_at >= $2::timestamptz';
  }
  const r = await pool.query(
    `SELECT id, nome_contato, nome_empresa, cnpj, whatsapp, tipo, created_at
     FROM leads_fesindico
     WHERE ${filtroData}
       AND id NOT IN (SELECT vencedor_id FROM sorteios_realizados)
     ORDER BY id`,
    params
  );
  return r.rows.filter((l) => !ehCadastroTeste(l));
}

app.get('/api/admin/sorteio/pool', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const dia = String(req.query.dia || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return res.status(400).json({ error: 'Parâmetro "dia" obrigatório (AAAA-MM-DD).' });
    const pool2 = await montarPoolSorteio(dia);
    res.json({
      dia, poolSize: pool2.length,
      pool: pool2.map((l) => ({
        id: l.id, nome: l.nome_contato || l.nome_empresa || '(sem nome — cadastro recorrente)',
        empresa: l.nome_empresa, cnpj: l.cnpj, whatsapp: l.whatsapp, tipo: l.tipo, criadoEm: l.created_at
      }))
    });
  } catch (err) {
    console.error('GET sorteio/pool error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sorteio/sortear', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const dia = String((req.body || {}).dia || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return res.status(400).json({ error: 'Campo "dia" obrigatório (AAAA-MM-DD).' });
    const pool2 = await montarPoolSorteio(dia);
    if (!pool2.length) return res.status(400).json({ error: 'Nenhum cadastro elegível pra esse dia.' });
    const vencedor = pool2[Math.floor(Math.random() * pool2.length)];
    const nome = vencedor.nome_contato || vencedor.nome_empresa || '(sem nome — cadastro recorrente)';
    await pool.query(
      `INSERT INTO sorteios_realizados (dia, pool_size, vencedor_id, vencedor_nome, vencedor_empresa, vencedor_cnpj, vencedor_whatsapp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [dia, pool2.length, vencedor.id, nome, vencedor.nome_empresa, vencedor.cnpj, vencedor.whatsapp]
    );
    res.json({
      dia, poolSize: pool2.length,
      vencedor: { id: vencedor.id, nome, empresa: vencedor.nome_empresa, cnpj: vencedor.cnpj, whatsapp: vencedor.whatsapp, tipo: vencedor.tipo, criadoEm: vencedor.created_at }
    });
  } catch (err) {
    console.error('POST sorteio/sortear error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 23/09/2026, pedido do Victor: apagar o histórico de sorteios (ex.: limpar
// sorteios de teste antes do sorteio de verdade). Atenção: como o pool do
// sorteio exclui quem já aparece aqui, apagar o histórico também "devolve"
// os ex-vencedores pro pool — o frontend avisa isso antes de confirmar.
app.delete('/api/admin/sorteio/historico', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const r = await pool.query('DELETE FROM sorteios_realizados');
    res.json({ ok: true, apagados: r.rowCount });
  } catch (err) {
    console.error('DELETE sorteio/historico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sorteio/historico', async (req, res) => {
  try {
    if (!checarTokenAdmin(req, res)) return;
    const r = await pool.query('SELECT * FROM sorteios_realizados ORDER BY id DESC');
    res.json(r.rows);
  } catch (err) {
    console.error('GET sorteio/historico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
