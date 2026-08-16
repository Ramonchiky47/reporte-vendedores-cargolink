// Migra todos los datos reales de catalogo.db (SQLite) a Supabase (Postgres).
// Uso: DATABASE_URL="postgresql://..." node scripts/migrar-a-supabase.js
//
// Requiere que el esquema ya exista en Supabase (tablas vacias) y que better-sqlite3
// siga instalado (queda como devDependency solo para este script).
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Define DATABASE_URL con la cadena de conexion a Supabase antes de ejecutar este script.');
  process.exit(1);
}

const sqlite = new Database(path.join(__dirname, '..', 'catalogo.db'), { readonly: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Orden de migracion: las tablas sin dependencias primero, luego las que las referencian.
const TABLAS = [
  'destinos',
  'empresas',
  'destino_empresas',
  'estatus_catalogo',
  'estados_entrega',
  'categorias',
  'lineas',
  'marcas',
  'productos',
  'detalle_de_compra',
  'usuarios',
  'permisos',
  'representantes',
  'contactos',
  'contacto_destinos',
  'etapas_negocio',
  'negocios',
  'cotizaciones',
  'cotizacion_items',
  'negocio_notas',
  'actividades',
  'pendientes',
  'pendiente_actividades',
  'pendiente_notas',
  'ordenes',
];

// Columnas con secuencia SERIAL en Postgres cuyo contador hay que reajustar despues de
// insertar filas con IDs explicitos (para que el siguiente INSERT sin id no choque).
const SECUENCIAS = {
  destinos: 'id_destino',
  empresas: 'id_empresa',
  destino_empresas: 'id',
  estatus_catalogo: 'id_estatus',
  estados_entrega: 'id_estado_entrega',
  detalle_de_compra: 'id_detalle_compra',
  usuarios: 'id_usuario',
  permisos: 'id',
  representantes: 'id_representante',
  contactos: 'id_contacto',
  contacto_destinos: 'id',
  etapas_negocio: 'id_etapa',
  cotizacion_items: 'id',
  negocio_notas: 'id',
  actividades: 'id_actividad',
  pendiente_actividades: 'id',
  pendiente_notas: 'id',
};

async function migrarTabla(client, tabla) {
  const filas = sqlite.prepare(`SELECT * FROM ${tabla}`).all();
  if (!filas.length) {
    console.log(`${tabla}: 0 filas (sin datos que migrar)`);
    return 0;
  }

  const columnas = Object.keys(filas[0]);
  const listaColumnas = columnas.map((c) => `"${c}"`).join(', ');

  for (const fila of filas) {
    const valores = columnas.map((c) => fila[c]);
    const placeholders = columnas.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(`INSERT INTO ${tabla} (${listaColumnas}) VALUES (${placeholders})`, valores);
  }

  console.log(`${tabla}: ${filas.length} fila(s) migrada(s)`);
  return filas.length;
}

async function reajustarSecuencia(client, tabla, columna) {
  await client.query(
    `SELECT setval(pg_get_serial_sequence('${tabla}', '${columna}'), COALESCE((SELECT MAX("${columna}") FROM ${tabla}), 1))`
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    for (const tabla of TABLAS) {
      await migrarTabla(client, tabla);
    }

    for (const [tabla, columna] of Object.entries(SECUENCIAS)) {
      await reajustarSecuencia(client, tabla, columna);
    }

    await client.query('COMMIT');
    console.log('\nMigracion completada correctamente.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nMigracion revertida por un error:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main();
