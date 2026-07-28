import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.stl', 'application/octet-stream'],
  ['.skn', 'application/octet-stream'],
]);

function parseArguments(argv) {
  const result = {
    root: path.resolve(process.cwd(), 'site'),
    port: 4173,
    page: '/?mode=sysid',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--root' && next) {
      result.root = path.resolve(next);
      index += 1;
    } else if (argument === '--port' && next) {
      result.port = Number.parseInt(next, 10);
      index += 1;
    } else if (argument === '--page' && next) {
      result.page = next;
      index += 1;
    }
  }

  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error(`Invalid port: ${result.port}`);
  }
  if (!result.page.startsWith('/')) {
    throw new Error('The --page value must start with /');
  }
  return result;
}

function resolveRequestPath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }

  const relative = decoded.replace(/^[/\\]+/, '');
  const candidate = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    return null;
  }
  return candidate;
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

async function findStaticFile(root, pathname, acceptsHtml) {
  let candidate = resolveRequestPath(root, pathname);
  if (!candidate) {
    return null;
  }

  try {
    const stats = await fsp.stat(candidate);
    if (stats.isDirectory()) {
      candidate = path.join(candidate, 'index.html');
      await fsp.access(candidate);
    }
    return candidate;
  } catch {
    if (!acceptsHtml) {
      return null;
    }
    const fallback = path.join(root, 'index.html');
    try {
      await fsp.access(fallback);
      return fallback;
    } catch {
      return null;
    }
  }
}

function openBrowser(url) {
  const command = `start "" "${url.replaceAll('"', '')}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function createRequestHandler(root) {
  const rootStats = await fsp.stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`Static root is not a directory: ${root}`);
  }

  return async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/__health') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('ok\n');
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }

      const acceptsHtml = String(request.headers.accept ?? '').includes('text/html');
      const filePath = await findStaticFile(root, requestUrl.pathname, acceptsHtml);
      if (!filePath) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found\n');
        return;
      }

      const stats = await fsp.stat(filePath);
      response.writeHead(200, {
        'content-type': contentType(filePath),
        'content-length': stats.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      console.error('[g1-sysid-viewer] request failed:', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('Internal server error\n');
    }
  };
}

async function listenWithFallback(handler, startingPort) {
  for (let port = startingPort; port < startingPort + 20; port += 1) {
    const server = http.createServer((request, response) => {
      handler(request, response);
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return { server, port };
    } catch (error) {
      server.close();
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  throw new Error(`No available port found from ${startingPort} to ${startingPort + 19}`);
}

const options = parseArguments(process.argv.slice(2));
const handler = await createRequestHandler(options.root);
const { server, port } = await listenWithFallback(handler, options.port);
const pageUrl = new URL(options.page, `http://127.0.0.1:${port}`).toString();

console.log('G1_SYSID_VIEWER_PORTABLE_V1');
console.log(`[g1-sysid-viewer] root: ${options.root}`);
console.log(`[g1-sysid-viewer] url:  ${pageUrl}`);
console.log('[g1-sysid-viewer] Keep this window open. Press Ctrl+C to stop.');

openBrowser(pageUrl);

const stop = () => {
  console.log('\n[g1-sysid-viewer] stopping...');
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
