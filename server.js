import 'dotenv/config';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { json, serveStatic } from './lib/http.js';
import * as cuadresStock from './modules/cuadres-stock/service.js';
import * as cargarStockFinal from './modules/cargar-stock-final/service.js';
import * as ventas from './modules/ventas/service.js';
import * as kardex from './modules/kardex/service.js';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT_PUBLIC_DIR = join(process.cwd(), 'public');
const modules = [cuadresStock, cargarStockFinal, ventas, kardex];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (url.pathname === '/') return serveStatic(ROOT_PUBLIC_DIR, '/', response);

    const module = modules.find((mod) => url.pathname === mod.prefix || url.pathname.startsWith(`${mod.prefix}/`));
    if (module) return module.handleRequest(url.pathname.slice(module.prefix.length) || '/', url, request, response);

    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: 'No se pudo consultar Logística. Intenta nuevamente.' });
  }
});

server.listen(PORT, () => console.log(`Panel disponible en http://localhost:${PORT}`));
