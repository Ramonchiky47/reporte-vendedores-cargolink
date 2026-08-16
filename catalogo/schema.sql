-- Esquema completo de la base de datos de Catalogo (CRM-ON), sin datos.
-- Generado a partir del historial de migraciones del proyecto Supabase original
-- (lcroyltwviddtdxqwzox) el 2026-08-16.
--
-- Uso: pega este archivo completo en el SQL Editor de un proyecto de Supabase NUEVO
-- (vacio) y ejecutalo una sola vez. Al terminar, tendras todas las tablas, indices,
-- llaves foraneas y políticas de RLS, pero sin ningun registro (0 filas).
--
-- Despues de correrlo necesitas crear al menos un usuario admin manualmente en la
-- tabla "usuarios" (password_hash con bcrypt) para poder entrar a la app.

-- ============================================================
-- 20260804163135_schema_inicial_crm_on
-- ============================================================
CREATE TABLE destinos (
  id_destino SERIAL PRIMARY KEY,
  destino TEXT NOT NULL UNIQUE
);

CREATE TABLE empresas (
  id_empresa SERIAL PRIMARY KEY,
  empresa TEXT NOT NULL UNIQUE
);

CREATE TABLE destino_empresas (
  id SERIAL PRIMARY KEY,
  destino_id INTEGER NOT NULL REFERENCES destinos(id_destino) ON DELETE CASCADE,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id_empresa) ON DELETE CASCADE,
  UNIQUE(destino_id, empresa_id)
);

CREATE TABLE estatus_catalogo (
  id_estatus SERIAL PRIMARY KEY,
  estatus TEXT NOT NULL UNIQUE
);

CREATE TABLE estados_entrega (
  id_estado_entrega SERIAL PRIMARY KEY,
  estado_entrega TEXT NOT NULL UNIQUE
);

CREATE TABLE categorias (
  id_categoria TEXT PRIMARY KEY,
  categoria TEXT NOT NULL UNIQUE
);

CREATE TABLE lineas (
  id_linea TEXT PRIMARY KEY,
  linea TEXT NOT NULL UNIQUE
);

CREATE TABLE marcas (
  id_marca TEXT PRIMARY KEY,
  marca TEXT NOT NULL UNIQUE
);

CREATE TABLE productos (
  item TEXT PRIMARY KEY,
  descripcion TEXT,
  categoria_id TEXT REFERENCES categorias(id_categoria),
  linea_id TEXT REFERENCES lineas(id_linea),
  marca_id TEXT REFERENCES marcas(id_marca),
  precio_usd NUMERIC NOT NULL,
  precio_mxn NUMERIC,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE detalle_de_compra (
  id_detalle_compra SERIAL PRIMARY KEY,
  id TEXT NOT NULL,
  articulo TEXT,
  tipo TEXT,
  fecha TEXT,
  numero_serie TEXT,
  cantidad_vendida NUMERIC,
  importe NUMERIC,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_detalle_compra_id ON detalle_de_compra(id);

CREATE TABLE usuarios (
  id_usuario SERIAL PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  es_admin INTEGER NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permisos (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
  modulo TEXT NOT NULL,
  puede_ver INTEGER NOT NULL DEFAULT 0,
  puede_editar INTEGER NOT NULL DEFAULT 0,
  puede_borrar INTEGER NOT NULL DEFAULT 0,
  UNIQUE(usuario_id, modulo)
);

CREATE TABLE representantes (
  id_representante SERIAL PRIMARY KEY,
  representante TEXT NOT NULL,
  correo_electronico TEXT,
  celular TEXT
);

CREATE TABLE contactos (
  id_contacto SERIAL PRIMARY KEY,
  id_publico TEXT,
  nombre TEXT NOT NULL,
  apellido TEXT,
  correo_electronico TEXT,
  telefono_local TEXT,
  telefono_celular TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_contactos_id_publico_unico ON contactos (id_publico) WHERE id_publico IS NOT NULL;

CREATE TABLE contacto_destinos (
  id SERIAL PRIMARY KEY,
  contacto_id INTEGER NOT NULL REFERENCES contactos(id_contacto) ON DELETE CASCADE,
  destino_id INTEGER NOT NULL REFERENCES destinos(id_destino) ON DELETE CASCADE,
  UNIQUE(contacto_id, destino_id)
);

CREATE TABLE etapas_negocio (
  id_etapa SERIAL PRIMARY KEY,
  etapa TEXT NOT NULL UNIQUE
);

CREATE TABLE negocios (
  id_negocio TEXT PRIMARY KEY,
  negocio TEXT NOT NULL,
  contacto_id INTEGER REFERENCES contactos(id_contacto),
  etapa_id INTEGER REFERENCES etapas_negocio(id_etapa),
  motivo_perdida TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cotizaciones (
  id_cotizacion TEXT PRIMARY KEY,
  negocio_id TEXT NOT NULL REFERENCES negocios(id_negocio),
  nombre TEXT NOT NULL,
  contacto_id INTEGER REFERENCES contactos(id_contacto),
  destino_id INTEGER REFERENCES destinos(id_destino),
  moneda TEXT NOT NULL CHECK (moneda IN ('USD','MXN')),
  etapa TEXT NOT NULL DEFAULT 'Negociacion' CHECK (etapa IN ('Negociacion','Ganada','Perdida')),
  descuento_porcentaje NUMERIC NOT NULL DEFAULT 0,
  subtotal NUMERIC NOT NULL DEFAULT 0,
  descuento_monto NUMERIC NOT NULL DEFAULT 0,
  iva NUMERIC NOT NULL DEFAULT 0,
  gran_total NUMERIC NOT NULL DEFAULT 0,
  fecha_creacion TEXT NOT NULL DEFAULT (CURRENT_DATE)::text,
  fecha_vencimiento TEXT,
  fecha_seguimiento TEXT,
  metodo_pago TEXT,
  lugar_entrega TEXT,
  tiempo_entrega TEXT,
  observaciones TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cotizacion_items (
  id SERIAL PRIMARY KEY,
  cotizacion_id TEXT NOT NULL REFERENCES cotizaciones(id_cotizacion) ON DELETE CASCADE,
  producto_item TEXT REFERENCES productos(item),
  cantidad NUMERIC NOT NULL,
  precio_unitario NUMERIC NOT NULL
);

CREATE TABLE negocio_notas (
  id SERIAL PRIMARY KEY,
  negocio_id TEXT NOT NULL REFERENCES negocios(id_negocio) ON DELETE CASCADE,
  nota TEXT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE actividades (
  id_actividad SERIAL PRIMARY KEY,
  actividad TEXT NOT NULL UNIQUE
);

CREATE TABLE pendientes (
  id_pendiente TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  fecha_compromiso TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pendiente_actividades (
  id SERIAL PRIMARY KEY,
  pendiente_id TEXT NOT NULL REFERENCES pendientes(id_pendiente) ON DELETE CASCADE,
  actividad_id INTEGER NOT NULL REFERENCES actividades(id_actividad) ON DELETE CASCADE,
  UNIQUE(pendiente_id, actividad_id)
);

CREATE TABLE pendiente_notas (
  id SERIAL PRIMARY KEY,
  pendiente_id TEXT NOT NULL REFERENCES pendientes(id_pendiente) ON DELETE CASCADE,
  nota TEXT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ordenes (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL,
  imprimir TEXT,
  nombre TEXT,
  numero_oc TEXT,
  estatus_sistema TEXT,
  numero_seguimiento TEXT,
  nota TEXT,
  moneda TEXT CHECK (moneda IS NULL OR length(moneda) <= 5),
  importe_moneda_extranjera NUMERIC,
  importe NUMERIC,
  estatus_id INTEGER REFERENCES estatus_catalogo(id_estatus),
  observaciones TEXT,
  destino_id INTEGER REFERENCES destinos(id_destino),
  contacto_id INTEGER REFERENCES contactos(id_contacto),
  estado_entrega_id INTEGER REFERENCES estados_entrega(id_estado_entrega),
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 20260804163153_tabla_sesiones_connect_pg_simple
-- ============================================================
CREATE TABLE "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "IDX_session_expire" ON "session" ("expire");

-- ============================================================
-- 20260804163745_creado_en_como_texto
-- ============================================================
ALTER TABLE productos ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE detalle_de_compra ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE usuarios ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE contactos ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE negocios ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE cotizaciones ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE negocio_notas ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE pendientes ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE pendiente_notas ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE ordenes ALTER COLUMN creado_en TYPE TEXT, ALTER COLUMN creado_en SET DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS');

-- ============================================================
-- 20260805165028_cotizador_privado_por_usuario
-- ============================================================
ALTER TABLE contactos ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id_usuario);
ALTER TABLE destinos ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id_usuario);
ALTER TABLE negocios ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id_usuario);
ALTER TABLE cotizaciones ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id_usuario);

-- (En el proyecto original aqui se rellenaba usuario_id=3 en filas existentes; en un
-- esquema vacio no hay filas que rellenar, asi que ese paso se omite.)

ALTER TABLE contactos ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE destinos ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE negocios ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE cotizaciones ALTER COLUMN usuario_id SET NOT NULL;

CREATE INDEX idx_contactos_usuario ON contactos(usuario_id);
CREATE INDEX idx_destinos_usuario ON destinos(usuario_id);
CREATE INDEX idx_negocios_usuario ON negocios(usuario_id);
CREATE INDEX idx_cotizaciones_usuario ON cotizaciones(usuario_id);

-- ============================================================
-- 20260805165107_correo_contacto_unico_por_usuario
-- ============================================================
CREATE UNIQUE INDEX idx_contactos_correo_unico ON contactos (usuario_id, lower(correo_electronico)) WHERE correo_electronico IS NOT NULL;

-- ============================================================
-- 20260805165214_destino_unico_por_usuario
-- ============================================================
CREATE UNIQUE INDEX destinos_usuario_destino_unico ON destinos (usuario_id, destino);

-- ============================================================
-- 20260805231812_representante_en_cotizaciones
-- ============================================================
ALTER TABLE cotizaciones ADD COLUMN representante_id INTEGER REFERENCES representantes(id_representante);

-- ============================================================
-- 20260806170052_negocio_id_en_pendientes
-- ============================================================
ALTER TABLE pendientes ADD COLUMN negocio_id TEXT REFERENCES negocios(id_negocio) ON DELETE SET NULL;
CREATE INDEX idx_pendientes_negocio ON pendientes(negocio_id);

-- ============================================================
-- 20260809225021_google_tasks_integracion
-- ============================================================
ALTER TABLE pendientes ADD COLUMN google_task_id text;

CREATE TABLE google_tasks_conexion (
  id integer PRIMARY KEY DEFAULT 1,
  access_token text,
  refresh_token text,
  token_expira_en timestamptz,
  tasklist_id text,
  conectado_por text,
  conectado_en timestamptz DEFAULT now(),
  CONSTRAINT google_tasks_conexion_singleton CHECK (id = 1)
);

-- ============================================================
-- 20260811193326_crear_grupos_cadenas
-- ============================================================
CREATE TABLE grupos (
  id_grupo SERIAL PRIMARY KEY,
  grupo TEXT UNIQUE NOT NULL
);

CREATE TABLE destino_grupos (
  id SERIAL PRIMARY KEY,
  destino_id INTEGER NOT NULL REFERENCES destinos(id_destino) ON DELETE CASCADE,
  grupo_id INTEGER NOT NULL REFERENCES grupos(id_grupo) ON DELETE CASCADE,
  UNIQUE (destino_id, grupo_id)
);

CREATE TABLE cadenas (
  id_cadena SERIAL PRIMARY KEY,
  cadena TEXT UNIQUE NOT NULL
);

CREATE TABLE destino_cadenas (
  id SERIAL PRIMARY KEY,
  destino_id INTEGER NOT NULL REFERENCES destinos(id_destino) ON DELETE CASCADE,
  cadena_id INTEGER NOT NULL REFERENCES cadenas(id_cadena) ON DELETE CASCADE,
  UNIQUE (destino_id, cadena_id)
);

-- ============================================================
-- 20260812180719_agregar_ubicacion_destinos
-- ============================================================
ALTER TABLE destinos ADD COLUMN ubicacion TEXT;

-- ============================================================
-- 20260812190843_habilitar_rls_solo_lectura_anon
-- ============================================================
-- Habilita RLS en todas las tablas. El backend (rol postgres, rolbypassrls=true) no se ve
-- afectado y sigue operando normalmente. Las tablas de negocio permiten SELECT a anon/
-- authenticated (necesario para Supabase Realtime desde el navegador); ninguna tabla permite
-- INSERT/UPDATE/DELETE a esos roles (todas las escrituras siguen pasando por la API de Express,
-- que ya valida sesion y permisos). Las tablas sensibles (contraseñas, sesiones, tokens OAuth,
-- permisos internos) quedan sin ninguna policy para anon/authenticated: acceso totalmente denegado.

-- Tablas sensibles: RLS habilitado, sin policies (denegado por defecto para anon/authenticated).
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_tasks_conexion ENABLE ROW LEVEL SECURITY;
ALTER TABLE permisos ENABLE ROW LEVEL SECURITY;

-- Tablas de negocio: RLS habilitado + solo lectura para anon/authenticated.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'actividades','cadenas','categorias','contacto_destinos','contactos','cotizacion_items',
    'cotizaciones','destino_cadenas','destino_empresas','destino_grupos','destinos',
    'detalle_de_compra','empresas','estados_entrega','estatus_catalogo','etapas_negocio',
    'grupos','lineas','marcas','negocio_notas','negocios','ordenes','pendiente_actividades',
    'pendiente_notas','pendientes','productos','representantes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "solo_lectura_anon" ON %I FOR SELECT TO anon, authenticated USING (true)',
      t
    );
  END LOOP;
END $$;

-- ============================================================
-- 20260813155929_agregar_firma_representantes
-- ============================================================
ALTER TABLE representantes ADD COLUMN firma TEXT;

-- ============================================================
-- 20260814124257_pendientes_contacto_destino
-- ============================================================
ALTER TABLE pendientes ADD COLUMN contacto_id integer REFERENCES contactos(id_contacto) ON DELETE SET NULL;
ALTER TABLE pendientes ADD COLUMN destino_id integer REFERENCES destinos(id_destino) ON DELETE SET NULL;

-- ============================================================
-- 20260814132844_negocios_fecha_estimada_cierre
-- ============================================================
ALTER TABLE negocios ADD COLUMN fecha_estimada_cierre text;
