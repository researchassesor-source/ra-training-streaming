# Migración a PostgreSQL

PostgreSQL almacena el estado estructurado de la aplicación. R2/S3 se mantiene para grabaciones, uploads y artefactos binarios.

## Variables

```env
DATA_BACKEND=legacy|postgres
DATABASE_URL=
DATABASE_URL_DIRECT=
TEST_DATABASE_URL=
```

- `DATABASE_URL`: conexión runtime, puede ser pooled.
- `DATABASE_URL_DIRECT`: conexión directa para migraciones/importaciones. Si no existe en desarrollo, se usa `DATABASE_URL`.

No incluyas credenciales reales en el repositorio.

## Orden operativo

1. Configura `DATABASE_URL` y, si aplica, `DATABASE_URL_DIRECT`.
2. Ejecuta migraciones:

   ```bash
   npm run db:migrate
   ```

3. Revisa estado:

   ```bash
   npm run db:status
   ```

4. Ejecuta importación legacy sin escribir:

   ```bash
   npm run db:import:legacy -- --dry-run --source=auto
   ```

5. Revisa conflictos y conteos.
6. Importa:

   ```bash
   npm run db:import:legacy -- --source=auto
   ```

7. Verifica conteos y smoke test.
8. Activa PostgreSQL como fuente de verdad:

   ```env
   DATA_BACKEND=postgres
   ```

9. Ejecuta:

   ```bash
   npm test
   npm run test:postgres
   npm run build
   ```

Si `DATA_BACKEND=postgres` está activo y falta `DATABASE_URL`, el servidor debe fallar cerrado. No hay fallback runtime a JSON/R2 para entidades estructuradas.
