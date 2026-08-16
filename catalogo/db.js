const { Pool, types } = require('pg');

// better-sqlite3 devolvia columnas NUMERIC/INTEGER como numeros de JS de forma nativa;
// el driver de Postgres por default regresa NUMERIC y BIGINT como texto (para no perder
// precision). Se restablece el comportamiento anterior ya que los valores de este sistema
// (precios, cantidades, conteos) nunca se acercan al limite de precision de un float de JS.
types.setTypeParser(1700, (valor) => (valor === null ? null : parseFloat(valor))); // numeric
types.setTypeParser(20, (valor) => (valor === null ? null : parseInt(valor, 10))); // int8/bigint

if (!process.env.DATABASE_URL) {
  console.warn('Aviso: DATABASE_URL no esta definida. Configura la cadena de conexion a Supabase (Postgres) antes de iniciar el servidor.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Convierte los parametros de una consulta al estilo de Postgres ($1, $2, ...).
// Acepta el mismo estilo que usaba better-sqlite3: parametros posicionales ("?") o,
// si se manda un solo objeto, parametros nombrados ("@nombre").
function convertirPlaceholders(sql, params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const nombres = [];
    const texto = sql.replace(/@(\w+)/g, (_, nombre) => {
      nombres.push(nombre);
      return `$${nombres.length}`;
    });
    return { texto, valores: nombres.map((n) => params[0][n]) };
  }
  let i = 0;
  const texto = sql.replace(/\?/g, () => `$${++i}`);
  return { texto, valores: params };
}

function primeraColumna(fila) {
  if (!fila) return undefined;
  const valores = Object.values(fila);
  return valores.length ? valores[0] : undefined;
}

// Crea una "fuente" de consultas (pool o un client de una transaccion) con la misma forma
// que usaba better-sqlite3 (prepare().get/.all/.run()), pero asincrona.
function crearFuente(queryable) {
  return {
    prepare(sql) {
      return {
        async get(...params) {
          const { texto, valores } = convertirPlaceholders(sql, params);
          const { rows } = await queryable.query(texto, valores);
          return rows[0];
        },
        async all(...params) {
          const { texto, valores } = convertirPlaceholders(sql, params);
          const { rows } = await queryable.query(texto, valores);
          return rows;
        },
        async run(...params) {
          const { texto, valores } = convertirPlaceholders(sql, params);
          const esInsert = /^\s*insert/i.test(texto);
          const yaTieneReturning = /returning/i.test(texto);
          const textoFinal = esInsert && !yaTieneReturning ? `${texto} RETURNING *` : texto;
          const { rows, rowCount } = await queryable.query(textoFinal, valores);
          return { changes: rowCount, lastInsertRowid: primeraColumna(rows[0]) };
        },
      };
    },
    async exec(sql) {
      await queryable.query(sql);
    },
  };
}

const db = crearFuente(pool);

// Ejecuta fn(db) dentro de una transaccion (BEGIN/COMMIT/ROLLBACK) sobre un client dedicado
// del pool. fn recibe una "fuente" con la misma forma de db (prepare().get/.all/.run()).
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(crearFuente(client));
    await client.query('COMMIT');
    return resultado;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { db, pool, transaction };
