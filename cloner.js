const { chromium } = require('playwright');
const cheerio = require('cheerio');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Launch Chromium using Playwright (automatically falls back to system Edge or Chrome)
 */
async function launchBrowser() {
  const candidates = [
    { headless: true },
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
  ];

  // Keep SwiftShader / software WebGL active so Three.js & 3D WebGL sites render in headless containers
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
  ];

  let lastErr;
  for (const opts of candidates) {
    try {
      return await chromium.launch({
        ...opts,
        args: launchArgs,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not launch headless browser: ${lastErr?.message || 'Unknown error'}`);
}

/**
 * Determine local asset subfolder & safe filename from URL and content-type
 */
function classifyAsset(assetUrl, contentType = '') {
  try {
    const parsed = new URL(assetUrl);
    let pathname = decodeURIComponent(parsed.pathname || '/');
    let ext = path.extname(pathname).toLowerCase().split('?')[0];
    const ct = (contentType || '').toLowerCase();

    // Preserve exact original filename for ES module relative imports (e.g. rolldown-runtime.CMAw1HyY.mjs)
    const rawBasename = path.basename(pathname).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

    let folder = 'other';
    if (ct.includes('text/css') || ext === '.css') {
      folder = 'css';
      if (!ext) ext = '.css';
    } else if (
      ct.includes('javascript') ||
      ct.includes('ecmascript') ||
      ext === '.js' ||
      ext === '.mjs' ||
      pathname.includes('.js@')
    ) {
      folder = 'js';
      if (!['.js', '.mjs'].includes(ext)) {
        ext = pathname.endsWith('.mjs') ? '.mjs' : '.js';
      }
    } else if (
      ct.includes('font/') ||
      ct.includes('application/font') ||
      ct.includes('woff') ||
      ['.woff2', '.woff', '.ttf', '.otf', '.eot'].includes(ext)
    ) {
      folder = 'fonts';
      if (!ext) {
        if (ct.includes('woff2')) ext = '.woff2';
        else if (ct.includes('woff')) ext = '.woff';
        else if (ct.includes('ttf')) ext = '.ttf';
        else ext = '.woff2';
      }
    } else if (
      ct.includes('image/') ||
      ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp'].includes(ext)
    ) {
      folder = 'images';
      if (!ext) {
        if (ct.includes('svg')) ext = '.svg';
        else if (ct.includes('webp')) ext = '.webp';
        else if (ct.includes('png')) ext = '.png';
        else if (ct.includes('gif')) ext = '.gif';
        else if (ct.includes('avif')) ext = '.avif';
        else if (ct.includes('icon')) ext = '.ico';
        else ext = '.jpg';
      }
    } else if (ct.includes('video/') || ct.includes('audio/') || ['.mp4', '.webm', '.mp3'].includes(ext)) {
      folder = 'media';
      if (!ext) ext = '.mp4';
    } else if (ext === '.framercms') {
      folder = 'js';
    } else if (['.glb', '.gltf', '.splinecode', '.lottie', '.rive', '.bin', '.hdr', '.wasm'].includes(ext)) {
      folder = 'other';
    } else {
      return null; // Skip non-static asset responses (e.g. XHR JSON, HTML documents)
    }

    let base = path.basename(pathname, path.extname(pathname)).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!base || base === '_') base = 'asset';
    if (base.length > 48) base = base.slice(0, 48);

    const hash = crypto.createHash('md5').update(assetUrl).digest('hex').slice(0, 8);
    const filename = `${base}-${hash}${ext}`;

    // For JS/MJS/FramerCMS/3D modules, also track the exact original filename so relative imports resolve
    const originalFilename =
      (folder === 'js' || folder === 'other') && rawBasename && rawBasename.length <= 140
        ? rawBasename
        : null;

    return {
      folder,
      filename,
      originalFilename,
      relativePath: originalFilename ? `assets/${folder}/${originalFilename}` : `assets/${folder}/${filename}`,
      hashedRelativePath: `assets/${folder}/${filename}`,
    };
  } catch {
    return null;
  }
}

/**
 * Convert a page URL into a clean local HTML filename (e.g. /pricing -> pricing.html)
 */
function pageUrlToFilename(targetUrl, rootOrigin, indexCounter = 0) {
  try {
    const u = new URL(targetUrl);
    if (u.origin !== rootOrigin && indexCounter > 0) {
      return `external-page-${indexCounter}.html`;
    }
    let cleanPath = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) return 'index.html';

    // Remove .html or .htm suffix if already present
    cleanPath = cleanPath.replace(/\.html?$/i, '');
    let safeName = cleanPath.replace(/[^a-zA-Z0-9/_-]/g, '-').replace(/\//g, '__');
    if (!safeName) safeName = `page-${indexCounter}`;
    return `${safeName}.html`;
  } catch {
    return indexCounter === 0 ? 'index.html' : `page-${indexCounter}.html`;
  }
}

/**
 * Normalize URL for deduplication (strip hashes and trailing slashes)
 */
function normalizePageUrl(rawUrl, baseUrl) {
  try {
    const u = new URL(rawUrl, baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    // Strip trailing slash except for root "/"
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Parse Cookie input (supports Cookie-Editor JSON array or header string)
 */
function parseUserCookies(cookieInput, targetUrl) {
  if (!cookieInput || !cookieInput.trim()) return [];
  const raw = cookieInput.trim();
  const u = new URL(targetUrl);

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((c) => c && c.name && typeof c.value !== 'undefined')
        .map((c) => {
          const cookie = {
            name: String(c.name),
            value: String(c.value),
            domain: c.domain || u.hostname,
            path: c.path || '/',
            secure: Boolean(c.secure ?? (u.protocol === 'https:')),
            httpOnly: Boolean(c.httpOnly ?? false),
          };
          if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) {
            cookie.sameSite = c.sameSite;
          }
          return cookie;
        });
    }
  } catch {
    // Fallback: parse "key=value; key2=value2" cookie header string
    return raw
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) return null;
        return {
          name: pair.slice(0, eqIdx).trim(),
          value: pair.slice(eqIdx + 1).trim(),
          domain: u.hostname,
          path: '/',
        };
      })
      .filter(Boolean);
  }
  return [];
}

/**
 * Auto-scroll the page smoothly to trigger lazy images, IntersectionObservers, and scroll animations
 */
async function autoScrollPage(page) {
  await page.evaluate(async () => {
    // Force lazy images and iframes to eager load
    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
      el.setAttribute('loading', 'eager');
    });
    document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach((img) => {
      const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (dataSrc && !img.getAttribute('src')) {
        img.setAttribute('src', dataSrc);
      }
    });

    await new Promise((resolve) => {
      let currentScroll = 0;
      const step = 420;
      const maxScrollHeight = Math.min(document.body.scrollHeight || 12000, 22000);

      // Scroll down smoothly so IntersectionObservers trigger on every section
      const downTimer = setInterval(() => {
        window.scrollBy(0, step);
        currentScroll += step;
        if (currentScroll >= maxScrollHeight) {
          clearInterval(downTimer);
          setTimeout(() => {
            // Scroll back up in steps so sticky navbars reveal themselves
            window.scrollBy(0, -600);
            setTimeout(() => {
              window.scrollTo(0, 0);
              setTimeout(resolve, 450);
            }, 180);
          }, 350);
        }
      }, 115);
    });
  });
}

/**
 * Capture CSS-in-JS / constructed stylesheets that exist only in CSSOM memory
 */
async function inlineDynamicCssomStyles(page) {
  try {
    await page.evaluate(() => {
      const styleTags = Array.from(document.querySelectorAll('style'));
      styleTags.forEach((tag) => {
        if (tag.sheet && tag.innerHTML.trim().length === 0) {
          try {
            const rules = Array.from(tag.sheet.cssRules || [])
              .map((r) => r.cssText)
              .join('\n');
            if (rules) tag.textContent = rules;
          } catch {}
        }
      });
    });
  } catch {}
}

/**
 * Fix 5 core DOM serialization & animation bugs before capturing page.content():
 * 1. Restore inline `background: linear-gradient(...)` corrupted by Chromium CSSOM (`background-image: ;`)
 * 2. Reveal scroll-triggered / appear-animated elements left at `opacity: 0` or `opacity: 0.001`
 * 3. Fix `translateX(NaNpx)` in Framer/Webflow ticker carousels so background grids & logos appear
 * 4. Normalize off-screen scroll-linked transforms (`translateY(-112px)` navbar, `scale(0.8)` sections, `translateY(110px)` footer)
 * 5. Normalize animated SVG `stroke-dashoffset` so feature line icons render completely
 */
async function normalizeRenderedDomForClone(page) {
  try {
    await page.evaluate(() => {
      // 1. Fix corrupted inline styles (e.g. `background-image: ;` when shorthand uses CSS variables)
      document.querySelectorAll('[style]').forEach((el) => {
        let styleAttr = el.getAttribute('style') || '';
        const ssrStyle = el.getAttribute('data-cloner-init-style') || '';

        if (styleAttr.includes(': ;') || styleAttr.includes(':;')) {
          // Remove broken empty property declarations like `background-image: ;`
          styleAttr = styleAttr.replace(/[a-z-]+\s*:\s*;\s*/gi, '');

          // First try restoring original `background:` from SSR snapshot if it had a gradient or var()
          let restoredBg = '';
          if (ssrStyle) {
            const bgMatch = ssrStyle.match(/(?:^|;)\s*(background(?:-image|-color)?\s*:[^;]+)/i);
            if (bgMatch && bgMatch[1] && !bgMatch[1].includes('rgba(0, 0, 0, 0)')) {
              restoredBg = bgMatch[1].trim();
            }
          }

          // Fallback to live computed style from Chromium memory
          if (!restoredBg) {
            try {
              const cs = window.getComputedStyle(el);
              if (cs.backgroundImage && cs.backgroundImage !== 'none') {
                restoredBg = `background-image: ${cs.backgroundImage}`;
              } else if (
                cs.backgroundColor &&
                cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                cs.backgroundColor !== 'transparent'
              ) {
                restoredBg = `background-color: ${cs.backgroundColor}`;
              }
            } catch {}
          }

          if (restoredBg) {
            // Strip any transparent background-color that overwrote the gradient
            styleAttr = styleAttr.replace(/background-color\s*:\s*rgba\(0,\s*0,\s*0,\s*0\)\s*;?/gi, '');
            styleAttr = `${styleAttr.replace(/;+\s*$/, '')}; ${restoredBg};`;
          }
          el.setAttribute('style', styleAttr.trim());
        }
      });

      // 2. Fix `translateX(NaNpx)` and hidden scroll/appear/navigation elements
      document.querySelectorAll('[style]').forEach((el) => {
        const styleAttr = el.getAttribute('style') || '';
        if (!styleAttr) return;

        // Fix broken NaN ticker transforms (e.g., blue grid background behind tabs)
        if (styleAttr.includes('NaN')) {
          const fixed = styleAttr
            .replace(/translateX\([^)]*NaN[^)]*\)/gi, 'translateX(0px)')
            .replace(/translateY\([^)]*NaN[^)]*\)/gi, 'translateY(0px)')
            .replace(/opacity\s*:\s*0(?:\.0+)?\b/gi, 'opacity: 1');
          el.setAttribute('style', fixed);
          return;
        }

        const isNav =
          el.tagName === 'NAV' ||
          el.tagName === 'HEADER' ||
          el.getAttribute('name') === 'Navigation' ||
          el.getAttribute('data-framer-name') === 'Navigation' ||
          Boolean(el.querySelector && el.querySelector('nav'));

        const hasScrollOrAppearTransform =
          styleAttr.includes('will-change: transform') ||
          styleAttr.includes('will-change:transform') ||
          el.hasAttribute('data-framer-appear-id') ||
          el.hasAttribute('data-aos') ||
          isNav;

        if (hasScrollOrAppearTransform) {
          const op = el.style.opacity;
          if (op !== '' && parseFloat(op) < 0.5) {
            el.style.opacity = '1';
          }
          const tf = el.style.transform || '';
          if (tf && tf !== 'none') {
            // Preserve intentional 50% centering transforms, reset scroll/appear offsets & scales
            if (!tf.includes('-50%')) {
              el.style.transform = 'none';
            }
          }
          const flt = el.style.filter || '';
          if (flt && flt.includes('blur(') && !flt.includes('blur(0px)')) {
            el.style.filter = 'none';
          }
        }
      });

      // 3. Ensure SVG line icons with animated stroke-dashoffset are fully drawn
      document.querySelectorAll('svg path[stroke-dashoffset]').forEach((p) => {
        const offset = parseFloat(p.getAttribute('stroke-dashoffset') || '0');
        if (offset !== 0) {
          p.setAttribute('stroke-dashoffset', '0');
        }
      });

      // 4. Restore SPA #root/#app if React unmounted it after an uncaught async/WebGL error
      const rootEl = document.getElementById('root') || document.getElementById('app') || document.getElementById('__next');
      if (rootEl && rootEl.innerHTML.trim().length === 0 && window.__clonerSavedRootHtml) {
        rootEl.innerHTML = window.__clonerSavedRootHtml;
      }

      // 5. Hide completed loading overlays (e.g. `.loader.is-done`) so they don't block the UI
      document.querySelectorAll('.loader.is-done, [class*="loader"][class*="done"]').forEach((loader) => {
        loader.style.opacity = '0';
        loader.style.pointerEvents = 'none';
        loader.style.display = 'none';
      });

      // 6. Clean up temporary SSR style attributes
      document.querySelectorAll('[data-cloner-init-style]').forEach((el) => {
        el.removeAttribute('data-cloner-init-style');
      });
    });
  } catch {}
}

/**
 * Snapshot rendered <canvas> elements (e.g. Three.js 3D models, WebGL scenes, charts)
 * into real PNG image files in assets/images/ and set them as inline background-images
 * on the <canvas> so 3D scenes & charts appear 100% intact even when opened offline via file://
 */
async function captureCanvasSnapshots(page, saveBufferAsAsset, pageUrl) {
  try {
    const snapshots = await page.evaluate(() => {
      const results = [];
      const canvases = Array.from(document.querySelectorAll('canvas'));
      canvases.forEach((canvas, idx) => {
        try {
          const rect = canvas.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) return;
          const dataUrl = canvas.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 1500) {
            canvas.setAttribute('data-cloner-canvas-id', String(idx));
            results.push({ idx, dataUrl });
          }
        } catch {}
      });
      return results;
    });

    for (const item of snapshots) {
      const base64Data = item.dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      const syntheticUrl = new URL(`/canvas-snapshot-${item.idx}.png`, pageUrl).toString();
      const saved = saveBufferAsAsset(syntheticUrl, buf, 'image/png');
      if (saved) {
        await page.evaluate(
          ({ idx, relPath }) => {
            const c = document.querySelector(`canvas[data-cloner-canvas-id="${idx}"]`);
            if (c) {
              c.style.backgroundImage = `url("${relPath}")`;
              c.style.backgroundSize = 'contain';
              c.style.backgroundPosition = 'center';
              c.style.backgroundRepeat = 'no-repeat';
              c.removeAttribute('data-cloner-canvas-id');
            }
          },
          { idx: item.idx, relPath: saved.hashedRelativePath }
        );
      }
    }
  } catch {}
}

/**
 * Rewrite url(...) references inside CSS content and download any newly discovered sub-assets
 */
async function rewriteCssUrls(cssText, cssBaseUrl, assetMap, saveAssetFromUrl, depthPrefix = '../') {
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const matches = [...cssText.matchAll(urlRegex)];
  let updatedCss = cssText;

  for (const match of matches) {
    const fullMatch = match[0];
    const rawRef = (match[2] || '').trim();
    if (!rawRef || rawRef.startsWith('data:') || rawRef.startsWith('#')) continue;

    try {
      const resolvedUrl = new URL(rawRef, cssBaseUrl).toString();
      let assetInfo = assetMap.get(resolvedUrl);
      if (!assetInfo && saveAssetFromUrl) {
        assetInfo = await saveAssetFromUrl(resolvedUrl);
      }
      if (assetInfo) {
        const fileTarget = assetInfo.originalFilename || assetInfo.filename;
        const relPath =
          depthPrefix === '../'
            ? `../${assetInfo.folder}/${fileTarget}`
            : assetInfo.relativePath;
        updatedCss = updatedCss.split(fullMatch).join(`url("${relPath}")`);
      }
    } catch {}
  }

  return updatedCss;
}

/**
 * Build a Virtual File System (VFS) bundle (`assets/js/__cloner_vfs.js`) containing:
 * 1. All downloaded ES module scripts (.js / .mjs) so `<script type="module">` and dynamic `import()`
 *    can be booted via `<script type="importmap">` + `Blob` URLs even on `file://` (where Chrome blocks external module scripts).
 * 2. All downloaded 3D/WebGL/Lottie binary assets (.glb, .gltf, .splinecode, .lottie, .rive, .bin, .hdr, .wasm)
 *    so `fetch()` and `XMLHttpRequest` return the binary data immediately from memory on `file://` and offline!
 */
function buildUniversalOfflineVfs(siteDir, assetMap) {
  try {
    const jsDir = path.join(siteDir, 'assets', 'js');
    const otherDir = path.join(siteDir, 'assets', 'other');

    const modules = {};
    if (fs.existsSync(jsDir)) {
      for (const file of fs.readdirSync(jsDir)) {
        if ((file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.framercms')) && !file.startsWith('__cloner')) {
          try {
            const fullPath = path.join(jsDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.size <= 8 * 1024 * 1024) {
              modules[file] = fs.readFileSync(fullPath, 'utf8');
            }
          } catch {}
        }
      }
    }

    const binaryAssets = {};
    if (fs.existsSync(otherDir)) {
      for (const file of fs.readdirSync(otherDir)) {
        try {
          const fullPath = path.join(otherDir, file);
          const stat = fs.statSync(fullPath);
          if (stat.size <= 25 * 1024 * 1024) {
            const b64 = fs.readFileSync(fullPath).toString('base64');
            binaryAssets[`assets/other/${file}`] = b64;
            binaryAssets[file] = b64;
          }
        } catch {}
      }
    }

    // Also map original remote URLs and root-relative pathnames (e.g. "/models/clara-rigged.glb") to binaryAssets
    for (const [remoteUrl, info] of assetMap.entries()) {
      if (info.folder === 'other') {
        const key = info.relativePath;
        if (binaryAssets[key]) {
          binaryAssets[remoteUrl] = binaryAssets[key];
          try {
            const u = new URL(remoteUrl);
            if (u.pathname) {
              binaryAssets[u.pathname] = binaryAssets[key];
            }
          } catch {}
        }
      }
    }

    const vfsJs = `window.__CLONER_MODULES__ = ${JSON.stringify(modules)};\nwindow.__CLONER_BINARY_ASSETS__ = ${JSON.stringify(binaryAssets)};\n`;
    fs.writeFileSync(path.join(jsDir, '__cloner_vfs.js'), vfsJs, 'utf8');
    return Object.keys(modules).length > 0 || Object.keys(binaryAssets).length > 0;
  } catch {
    return false;
  }
}

/**
 * Inject a lightweight CSS + JS runtime guard + VFS ES Module / 3D Asset Bootloader into cloned HTML pages so:
 * 1. `<script type="module">` and dynamic `import()` run with 0 CORS errors on `file://` via Blob URLs + `<script type="importmap">`
 * 2. 3D WebGL models (`.glb`, `.gltf`, `.splinecode`, `.wasm`) load via in-memory `fetch`/`XHR` VFS on `file://` so 3D interactive animations (head tracking, breathing, zoom) work live!
 * 3. Sticky navbars, scroll-linked sections, ticker backgrounds, and button gradients are protected against hydration bugs.
 */
function injectClonerRuntimeEnhancer($, hasVfs = false, deferredModuleEntries = []) {
  const runtimeCss = `
<style id="cloner-runtime-styles">
  /* Keep navigation, appear elements & ticker backgrounds visible */
  [data-framer-name="Navigation"], [name="Navigation"] {
    opacity: 1 !important;
    transform: none !important;
  }
  [style*="translateX(NaNpx)"] {
    opacity: 1 !important;
    transform: translateX(0px) !important;
  }
  @keyframes cloner-marquee-left {
    0% { transform: translateX(0px); }
    100% { transform: translateX(-50%); }
  }
  .cloner-css-marquee {
    animation: cloner-marquee-left 28s linear infinite !important;
  }
</style>`;

  const vfsBootHead = hasVfs
    ? `
<script src="assets/js/__cloner_vfs.js"></script>
<script id="cloner-vfs-boot">
(function() {
  // 1. Safe History pushState/replaceState wrapper on file:// so SPA routers (Next.js/React Router/Framer) never crash with SecurityError
  if (window.location.protocol === 'file:') {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function() { try { return origPush.apply(this, arguments); } catch (e) {} };
    history.replaceState = function() { try { return origReplace.apply(this, arguments); } catch (e) {} };
  }

  // 2. Intercept fetch() & XMLHttpRequest for 3D models (.glb, .gltf, .splinecode, .wasm, .bin) on file:// & offline
  var binAssets = window.__CLONER_BINARY_ASSETS__ || {};
  function decodeBase64ToBytes(b64) {
    var binStr = atob(b64);
    var len = binStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  }
  function matchVfsAsset(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    if (binAssets[urlStr]) return binAssets[urlStr];
    var clean = urlStr.split('?')[0].split('#')[0];
    if (binAssets[clean]) return binAssets[clean];
    for (var key in binAssets) {
      if (clean.endsWith('/' + key) || clean === key) return binAssets[key];
    }
    return null;
  }

  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var urlStr = typeof input === 'string' ? input : (input && input.url) || '';
      var b64 = matchVfsAsset(urlStr);
      if (b64) {
        var bytes = decodeBase64ToBytes(b64);
        return Promise.resolve(new Response(bytes.buffer, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) }
        }));
      }
      return origFetch.apply(this, arguments);
    };
  }

  // 3. Build Blob URLs + ImportMap for ES modules so <script type="module"> & dynamic import() run on file:// with zero CORS errors
  var rawModules = window.__CLONER_MODULES__ || {};
  var moduleNames = Object.keys(rawModules);
  var entries = ${JSON.stringify(deferredModuleEntries)};
  if (moduleNames.length > 0 && entries.length > 0) {
    var rewrittenModules = {};
    moduleNames.forEach(function(name) {
      var code = rawModules[name];
      moduleNames.forEach(function(other) {
        code = code.split('"./' + other + '"').join('"@cloner/' + other + '"');
        code = code.split("'./" + other + "'").join("'@cloner/" + other + "'");
        code = code.split('\`./' + other + '\`').join('\`@cloner/' + other + '\`');
      });
      rewrittenModules[name] = code;
    });

    var importsMap = {};
    moduleNames.forEach(function(name) {
      var blob = new Blob([rewrittenModules[name]], { type: 'text/javascript' });
      var blobUrl = URL.createObjectURL(blob);
      importsMap['@cloner/' + name] = blobUrl;
      importsMap['./' + name] = blobUrl;
      importsMap['assets/js/' + name] = blobUrl;
    });

    var im = document.createElement('script');
    im.type = 'importmap';
    im.textContent = JSON.stringify({ imports: importsMap });
    document.head.appendChild(im);

    window.addEventListener('DOMContentLoaded', function() {
      entries.forEach(function(entry) {
        if (importsMap['@cloner/' + entry]) {
          var s = document.createElement('script');
          s.type = 'module';
          s.textContent = 'import "@cloner/' + entry + '";';
          document.body.appendChild(s);
        }
      });
    });
  }
})();
</script>`
    : '';

  const runtimeScript = `
<script id="cloner-runtime-script">
(function() {
  // 1. Snapshot clean button styles, rewritten local .html links, and pre-rendered SPA root before hydration
  var savedStyles = new WeakMap();
  var savedHrefs = new WeakMap();
  var savedRootHtml = '';

  function snapshotCleanDom() {
    var rootEl = document.getElementById('root') || document.getElementById('app') || document.getElementById('__next');
    if (rootEl && rootEl.innerHTML.trim().length > 100 && !savedRootHtml) {
      savedRootHtml = rootEl.innerHTML;
    }
    document.querySelectorAll('a[style], button[style], [data-framer-appear-id][style]').forEach(function(el) {
      var st = el.getAttribute('style') || '';
      if (st.includes('linear-gradient') || st.includes('background')) {
        savedStyles.set(el, st);
      }
    });
    document.querySelectorAll('a[href$=".html"], a[href*=".html#"]').forEach(function(a) {
      savedHrefs.set(a, a.getAttribute('href'));
    });
  }

  function repairHydrationArtifacts() {
    // Restore SPA #root ONLY if client-side re-mount crashed and emptied it completely
    var rootEl = document.getElementById('root') || document.getElementById('app') || document.getElementById('__next');
    if (rootEl && savedRootHtml && rootEl.innerHTML.trim().length === 0) {
      rootEl.innerHTML = savedRootHtml;
    }

    // If a live 3D WebGL engine (.stage.is-ready or canvas[data-engine]) has mounted, clear any static fallback background-image on the live canvas
    document.querySelectorAll('.stage.is-ready canvas, canvas[data-engine]').forEach(function(c) {
      if (c.style && c.style.backgroundImage && c.getAttribute('data-cloner-static-canvas') !== '1') {
        c.style.backgroundImage = 'none';
      }
    });

    // Restore any button gradient wiped by Framer Motion CSSOM bug
    document.querySelectorAll('a[style], button[style]').forEach(function(el) {
      var st = el.getAttribute('style') || '';
      if ((st.includes('background-image: ;') || st.includes('background-color: rgba(0, 0, 0, 0)')) && savedStyles.has(el)) {
        el.setAttribute('style', savedStyles.get(el));
      }
    });

    // Fix any ticker ul that computed translateX(NaNpx) or opacity: 0
    document.querySelectorAll('ul[style]').forEach(function(ul) {
      var st = ul.getAttribute('style') || '';
      if (st.includes('NaN')) {
        ul.style.opacity = '1';
        ul.style.transform = 'translateX(0px)';
      } else if (ul.children.length > 6 && st.includes('translateX(-0px)')) {
        ul.classList.add('cloner-css-marquee');
      }
    });

    // Keep scroll-linked sections visible & full-scale
    document.querySelectorAll('[style*="will-change: transform"]').forEach(function(el) {
      if (el.style.opacity !== '' && parseFloat(el.style.opacity) < 0.2) {
        el.style.opacity = '1';
      }
      var tf = el.style.transform || '';
      if (tf.includes('scale(0.8)') || tf.includes('translateY(50px)') || tf.includes('translateY(110px)') || tf.includes('translateY(-112px)') || tf.includes('rotateX(')) {
        el.style.transform = 'none';
      }
    });

    // Restore local .html hrefs if SPA router rewrote them
    document.querySelectorAll('a').forEach(function(a) {
      if (savedHrefs.has(a)) {
        var desired = savedHrefs.get(a);
        if (a.getAttribute('href') !== desired) {
          a.setAttribute('href', desired);
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      snapshotCleanDom();
      repairHydrationArtifacts();
    });
  } else {
    snapshotCleanDom();
    repairHydrationArtifacts();
  }

  // Observe and repair for the first 8 seconds while hydration/scroll settles
  var obs = new MutationObserver(function() {
    repairHydrationArtifacts();
  });
  if (document.documentElement) {
    obs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['style', 'href'] });
  }
  window.addEventListener('scroll', repairHydrationArtifacts, { passive: true });
})();
</script>`;

  if ($('head').length) {
    $('head').append(runtimeCss + vfsBootHead);
  } else {
    $.root().prepend(runtimeCss + vfsBootHead);
  }

  if ($('body').length) {
    $('body').append(runtimeScript);
  } else {
    $.root().append(runtimeScript);
  }
}

/**
 * Create a ZIP archive from a directory
 */
function createZipArchive(sourceDir, zipFilePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

/**
 * Main Website Cloner Runner
 */
async function runCloneJob(jobId, options, paths, emitProgress) {
  const {
    url: rawInputUrl,
    mode = 'single',
    maxPages: requestedMaxPages = 1,
    viewport = 'desktop',
    autoScroll = true,
    rewriteLinks = true,
    saveAssets = true,
    sameDomain = true,
    cookies = '',
  } = options;

  // Enforce maximum 50 pages limit
  const maxPages = mode === 'single' ? 1 : Math.min(Math.max(parseInt(requestedMaxPages, 10) || 1, 1), 50);

  let startUrl;
  try {
    startUrl = new URL(rawInputUrl.startsWith('http') ? rawInputUrl : `https://${rawInputUrl}`).toString();
  } catch {
    throw new Error('Invalid website URL provided.');
  }

  const rootUrlObj = new URL(startUrl);
  const rootOrigin = rootUrlObj.origin;
  const siteDir = path.join(paths.sitesDir, jobId);
  const zipPath = path.join(paths.zipsDir, `${jobId}.zip`);

  // Create output directories
  ['css', 'js', 'fonts', 'images', 'media', 'other'].forEach((sub) => {
    fs.mkdirSync(path.join(siteDir, 'assets', sub), { recursive: true });
  });

  // Track saved assets: assetUrl -> { folder, filename, originalFilename, relativePath, diskPath, baseUrl }
  const assetMap = new Map();
  // Track queued and visited pages: normalizedUrl -> localHtmlFilename
  const pageFileMap = new Map();
  const visitedPages = new Set();
  const pageQueue = [];

  const normalizedStart = normalizePageUrl(startUrl, startUrl) || startUrl;
  pageFileMap.set(normalizedStart, 'index.html');
  pageQueue.push(normalizedStart);

  // Store raw HTML & base URL for each captured page so we can rewrite all links after crawling
  const capturedPages = [];

  emitProgress({
    pct: 5,
    pages: 0,
    assets: 0,
    title: 'Launching headless browser…',
    log: `Starting Chromium (${viewport === 'mobile' ? 'Mobile 390×844' : 'Desktop 1440×900'})`,
    type: 'step',
  });

  const browser = await launchBrowser();

  try {
    const contextOptions =
      viewport === 'mobile'
        ? {
            viewport: { width: 390, height: 844 },
            userAgent:
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          }
        : {
            viewport: { width: 1440, height: 900 },
            userAgent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          };

    const context = await browser.newContext({
      ...contextOptions,
      ignoreHTTPSErrors: true,
    });

    // Snapshot original SSR inline `style` attributes, force WebGL preserveDrawingBuffer for 3D canvas capture,
    // and guard against React 18 unmounting #root on async WebGL/network errors
    await context.addInitScript(() => {
      try {
        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) {
          if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
            attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
          }
          return origGetContext.call(this, type, attrs);
        };
      } catch {}

      const saveInitStyle = (el) => {
        if (el && el.nodeType === 1 && el.hasAttribute('style') && !el.hasAttribute('data-cloner-init-style')) {
          el.setAttribute('data-cloner-init-style', el.getAttribute('style') || '');
        }
      };
      const snapshotRoot = () => {
        const r = document.getElementById('root') || document.getElementById('app') || document.getElementById('__next');
        if (r && r.innerHTML.trim().length > 100) {
          window.__clonerSavedRootHtml = r.innerHTML;
        }
      };
      const scanAll = () => {
        document.querySelectorAll('[style]').forEach(saveInitStyle);
        snapshotRoot();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanAll, { once: true });
      } else {
        scanAll();
      }
      new MutationObserver((mutations) => {
        snapshotRoot();
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node && node.nodeType === 1) {
              saveInitStyle(node);
              if (node.querySelectorAll) {
                node.querySelectorAll('[style]').forEach(saveInitStyle);
              }
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });

    // Inject session cookies if provided (Behind Login mode)
    if (cookies && cookies.trim()) {
      const parsedCookies = parseUserCookies(cookies, startUrl);
      if (parsedCookies.length > 0) {
        await context.addCookies(parsedCookies);
        emitProgress({
          pct: 8,
          pages: 0,
          assets: 0,
          title: 'Session cookies injected…',
          log: `Injected ${parsedCookies.length} session cookie(s) for authenticated capture`,
          type: 'step',
        });
      }
    }

    // Helper to save an asset buffer to disk
    const saveBufferAsAsset = (assetUrl, buffer, contentType = '') => {
      if (!saveAssets || !buffer || buffer.length === 0) return null;
      if (assetMap.has(assetUrl)) return assetMap.get(assetUrl);

      const classified = classifyAsset(assetUrl, contentType);
      if (!classified) return null;

      const primaryFilename = classified.originalFilename || classified.filename;
      const diskPath = path.join(siteDir, 'assets', classified.folder, primaryFilename);
      try {
        fs.writeFileSync(diskPath, buffer);
        // Also write hashed copy if originalFilename was used so both references resolve
        if (classified.originalFilename && classified.originalFilename !== classified.filename) {
          const hashedDiskPath = path.join(siteDir, 'assets', classified.folder, classified.filename);
          if (!fs.existsSync(hashedDiskPath)) {
            fs.writeFileSync(hashedDiskPath, buffer);
          }
        }
        const record = { ...classified, diskPath, baseUrl: assetUrl };
        assetMap.set(assetUrl, record);
        return record;
      } catch {
        return null;
      }
    };

    // Helper to explicitly fetch & save an asset URL that wasn't caught by network listener
    const fetchAndSaveAsset = async (assetUrl) => {
      if (!saveAssets || !assetUrl || assetUrl.startsWith('data:') || assetUrl.startsWith('blob:')) {
        return null;
      }
      if (assetMap.has(assetUrl)) return assetMap.get(assetUrl);

      try {
        const res = await context.request.get(assetUrl, { timeout: 10000, failOnStatusCode: false });
        if (!res.ok()) return null;
        const contentType = res.headers()['content-type'] || '';
        const buffer = await res.body();
        return saveBufferAsAsset(assetUrl, buffer, contentType);
      } catch {
        return null;
      }
    };

    const page = await context.newPage();

    // Intercept all network responses to save exact CSS, JS, Fonts & Images loaded by the browser
    page.on('response', async (response) => {
      try {
        if (!saveAssets) return;
        const reqUrl = response.url();
        if (!reqUrl.startsWith('http') || assetMap.has(reqUrl)) return;
        const status = response.status();
        if (status < 200 || status >= 300) return;

        const contentType = response.headers()['content-type'] || '';
        const classified = classifyAsset(reqUrl, contentType);
        if (!classified) return;

        const buffer = await response.body();
        saveBufferAsAsset(reqUrl, buffer, contentType);
      } catch {
        // Ignore body read errors on redirected/preflight requests
      }
    });

    // Crawl loop (1 page for Single mode, up to 50 pages for Full / Auth mode)
    while (pageQueue.length > 0 && visitedPages.size < maxPages) {
      const currentUrl = pageQueue.shift();
      if (!currentUrl || visitedPages.has(currentUrl)) continue;

      const pageIndex = visitedPages.size;
      visitedPages.add(currentUrl);

      const localFilename =
        pageFileMap.get(currentUrl) || pageUrlToFilename(currentUrl, rootOrigin, pageIndex);
      pageFileMap.set(currentUrl, localFilename);

      const basePct = 10 + Math.round(((pageIndex + 0.3) / maxPages) * 65);
      emitProgress({
        pct: Math.min(basePct, 75),
        pages: pageIndex + 1,
        assets: assetMap.size,
        title: `Capturing page ${pageIndex + 1} of ${maxPages}…`,
        log: `Visiting ${currentUrl} -> ${localFilename}`,
        type: 'step',
      });

      try {
        await page.goto(currentUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 35000,
        });

        // Wait for network idle (bundles, fonts, 3D .glb assets) up to 10s
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        // Wait for initial client-side hydration (React/Next/Framer/Three.js)
        await page.waitForTimeout(1800);

        // If the page has an active 3D/Suspense loader (e.g. .loader:not(.is-done)), wait up to 3s for it to finish
        await page
          .waitForFunction(
            () => {
              const loader = document.querySelector('.loader:not(.is-done)');
              return !loader;
            },
            { timeout: 3000 }
          )
          .catch(() => {});

        if (autoScroll) {
          emitProgress({
            pct: Math.min(basePct + 4, 78),
            pages: pageIndex + 1,
            assets: assetMap.size,
            title: `Scrolling page ${pageIndex + 1} for lazy content & animations…`,
            log: `Auto-scrolling ${localFilename} to trigger lazy images & scroll animations`,
            type: 'info',
          });
          await autoScrollPage(page);
        }

        // Wait for newly triggered network images/fonts, snapshot 3D/WebGL canvases & normalize DOM styles
        await page.waitForTimeout(800);
        await inlineDynamicCssomStyles(page);
        await captureCanvasSnapshots(page, saveBufferAsAsset, currentUrl);
        await normalizeRenderedDomForClone(page);

        const finalPageUrl = page.url() || currentUrl;
        const renderedHtml = await page.content();

        capturedPages.push({
          url: currentUrl,
          finalUrl: finalPageUrl,
          filename: localFilename,
          html: renderedHtml,
        });

        // If multi-page mode is active and we need more pages, discover internal links
        if (maxPages > 1 && pageFileMap.size < maxPages * 2) {
          const $ = cheerio.load(renderedHtml);
          $('a[href]').each((_, el) => {
            const rawHref = ($(el).attr('href') || '').trim();
            if (
              !rawHref ||
              rawHref.startsWith('#') ||
              rawHref.startsWith('mailto:') ||
              rawHref.startsWith('tel:') ||
              rawHref.startsWith('javascript:')
            ) {
              return;
            }

            const norm = normalizePageUrl(rawHref, finalPageUrl);
            if (!norm) return;

            try {
              const linkObj = new URL(norm);
              if (sameDomain && linkObj.origin !== rootOrigin) return;

              // Skip binary/file download links in page crawler queue
              const ext = path.extname(linkObj.pathname).toLowerCase();
              if (
                [
                  '.pdf', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.svg',
                  '.webp', '.mp4', '.mp3', '.css', '.js', '.xml', '.json',
                ].includes(ext)
              ) {
                return;
              }

              if (!visitedPages.has(norm) && !pageQueue.includes(norm)) {
                if (visitedPages.size + pageQueue.length < maxPages) {
                  const assignedFile = pageUrlToFilename(
                    norm,
                    rootOrigin,
                    visitedPages.size + pageQueue.length
                  );
                  pageFileMap.set(norm, assignedFile);
                  pageQueue.push(norm);
                }
              }
            } catch {}
          });
        }
      } catch (pageErr) {
        emitProgress({
          pct: Math.min(basePct, 75),
          pages: visitedPages.size,
          assets: assetMap.size,
          title: `Skipped unreachable page…`,
          log: `Warning on ${currentUrl}: ${pageErr.message}`,
          type: 'warn',
        });
      }
    }

    if (capturedPages.length === 0) {
      throw new Error('Could not capture any page content from the target URL.');
    }

    // Step 2: Process HTML DOMs, ensure all referenced assets are downloaded, and rewrite links
    emitProgress({
      pct: 80,
      pages: capturedPages.length,
      assets: assetMap.size,
      title: 'Processing DOM & downloading missing assets…',
      log: `Inspecting ${capturedPages.length} page(s) and verifying local assets`,
      type: 'step',
    });

    for (const pageItem of capturedPages) {
      const $ = cheerio.load(pageItem.html);
      const basePageUrl = pageItem.finalUrl || pageItem.url;

      // Remove base or CSP tags that break offline viewing
      $('base').remove();
      $('meta[http-equiv="Content-Security-Policy"]').remove();

      if (saveAssets) {
        // 1. Stylesheets & Modulepreload / Preload links (<link rel="stylesheet|modulepreload|preload" href="...">)
        const resourceLinks = $(
          'link[rel="stylesheet"][href], link[as="style"][href], link[rel="modulepreload"][href], link[rel="preload"][href]'
        ).toArray();
        for (const el of resourceLinks) {
          const href = $(el).attr('href');
          if (!href || href.startsWith('data:')) continue;
          try {
            const absUrl = new URL(href, basePageUrl).toString();
            const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
            if (saved && rewriteLinks) {
              $(el).attr('href', saved.relativePath);
              $(el).removeAttr('integrity');
              $(el).removeAttr('crossorigin');

              // Also inline stylesheet content into <style data-cloner-inlined-css> so CSS works even if opened inside an unextracted ZIP
              if (saved.folder === 'css' && ($(el).attr('rel') === 'stylesheet' || $(el).attr('as') === 'style')) {
                try {
                  const rawCss = fs.readFileSync(saved.diskPath, 'utf8');
                  const inlinedCss = rawCss.includes('url(')
                    ? await rewriteCssUrls(rawCss, saved.baseUrl, assetMap, fetchAndSaveAsset, 'assets/')
                    : rawCss;
                  $(el).after(`<style data-cloner-inlined-css="true">${inlinedCss}</style>`);
                } catch {}
              }
            }
          } catch {}
        }

        // 2. Images (<img src="...">, <img srcset="...">, <source srcset="...">)
        const imgElements = $('img, source, image').toArray();
        for (const el of imgElements) {
          const src = $(el).attr('src') || $(el).attr('data-src');
          if (src && !src.startsWith('data:')) {
            try {
              const absUrl = new URL(src, basePageUrl).toString();
              const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
              if (saved && rewriteLinks) {
                $(el).attr('src', saved.relativePath);
                $(el).removeAttr('srcset');
                $(el).removeAttr('data-src');
              }
            } catch {}
          } else if ($(el).attr('srcset')) {
            const firstSrc = ($(el).attr('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
            if (firstSrc && !firstSrc.startsWith('data:')) {
              try {
                const absUrl = new URL(firstSrc, basePageUrl).toString();
                const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
                if (saved && rewriteLinks) {
                  $(el).attr('src', saved.relativePath);
                  $(el).removeAttr('srcset');
                }
              } catch {}
            }
          }
        }

        // 3. Scripts (<script src="...">)
        const deferredModuleEntries = [];
        const scriptElements = $('script[src]').toArray();
        for (const el of scriptElements) {
          const src = $(el).attr('src');
          if (!src || src.startsWith('data:')) continue;
          try {
            const absUrl = new URL(src, basePageUrl).toString();
            const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
            if (saved && rewriteLinks) {
              $(el).attr('src', saved.relativePath);
              $(el).removeAttr('integrity');
              $(el).removeAttr('crossorigin');
              if (($(el).attr('type') || '').toLowerCase() === 'module') {
                const modName = path.basename(saved.relativePath);
                deferredModuleEntries.push(modName);
                // Remove direct <script type="module" src="..."> so Chrome file:// doesn't throw CORS error;
                // VFS ImportMap bootloader will execute it via Blob URL + ImportMap!
                $(el).remove();
              }
            }
          } catch {}
        }
        pageItem.deferredModuleEntries = deferredModuleEntries;

        // Remove <link rel="preload" as="fetch"> or <link rel="modulepreload"> that fail under file:// CORS
        $('link[rel="preload"][as="fetch"], link[rel="modulepreload"]').remove();

        // 4. Favicons (<link rel="icon" href="...">)
        const iconLinks = $('link[rel*="icon"][href]').toArray();
        for (const el of iconLinks) {
          const href = $(el).attr('href');
          if (!href || href.startsWith('data:')) continue;
          try {
            const absUrl = new URL(href, basePageUrl).toString();
            const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
            if (saved && rewriteLinks) {
              $(el).attr('href', saved.relativePath);
            }
          } catch {}
        }

        // 5. Inline <style> blocks with url(...)
        const inlineStyles = $('style').toArray();
        for (const el of inlineStyles) {
          const cssContent = $(el).html() || '';
          if (cssContent.includes('url(') && rewriteLinks) {
            const updated = await rewriteCssUrls(
              cssContent,
              basePageUrl,
              assetMap,
              fetchAndSaveAsset,
              'assets/'
            );
            $(el).html(updated);
          }
        }

        // 6. Inline style="..." attributes with url(...)
        const styledEls = $('[style*="url("]').toArray();
        for (const el of styledEls) {
          const styleAttr = $(el).attr('style') || '';
          if (rewriteLinks) {
            const updated = await rewriteCssUrls(
              styleAttr,
              basePageUrl,
              assetMap,
              fetchAndSaveAsset,
              'assets/'
            );
            $(el).attr('style', updated);
          }
        }
      }

      // 7. Rewrite internal <a href="..."> links to point to cloned local .html files
      if (rewriteLinks) {
        $('a[href]').each((_, el) => {
          const rawHref = ($(el).attr('href') || '').trim();
          if (
            !rawHref ||
            rawHref.startsWith('#') ||
            rawHref.startsWith('mailto:') ||
            rawHref.startsWith('tel:') ||
            rawHref.startsWith('javascript:')
          ) {
            return;
          }
          const norm = normalizePageUrl(rawHref, basePageUrl);
          if (norm && pageFileMap.has(norm)) {
            const targetLocalFile = pageFileMap.get(norm);
            if (visitedPages.has(norm)) {
              const hashIdx = rawHref.indexOf('#');
              const hashSuffix = hashIdx !== -1 ? rawHref.slice(hashIdx) : '';
              $(el).attr('href', `${targetLocalFile}${hashSuffix}`);
            }
          }
        });
      }

      // Temporarily store processed Cheerio instance so we can inject VFS after Step 3 rewrites JS/CSS
      pageItem.$ = $;
    }

    // Step 3: Rewrite url(...) inside all saved CSS files and remote/root-relative asset URLs inside JS/MJS modules
    let hasVfs = false;
    if (saveAssets && rewriteLinks) {
      emitProgress({
        pct: 90,
        pages: capturedPages.length,
        assets: assetMap.size,
        title: 'Rewriting CSS, JS & 3D VFS modules…',
        log: 'Updating url() and building offline Virtual File System for ES modules & 3D assets',
        type: 'step',
      });

      const cssRecords = [...assetMap.values()].filter((a) => a.folder === 'css');
      for (const cssAsset of cssRecords) {
        try {
          const rawCss = fs.readFileSync(cssAsset.diskPath, 'utf8');
          if (rawCss.includes('url(')) {
            const rewrittenCss = await rewriteCssUrls(
              rawCss,
              cssAsset.baseUrl,
              assetMap,
              fetchAndSaveAsset,
              '../'
            );
            fs.writeFileSync(cssAsset.diskPath, rewrittenCss, 'utf8');
          }
        } catch {}
      }

      // Rewrite already-captured remote & root-relative image/font/media/3D URLs inside JS/MJS bundles
      const jsRecords = [...assetMap.values()].filter(
        (a) => a.folder === 'js' && (a.diskPath.endsWith('.js') || a.diskPath.endsWith('.mjs'))
      );
      const replaceableAssets = [...assetMap.entries()].filter(
        ([url, info]) =>
          info.folder === 'images' ||
          info.folder === 'fonts' ||
          info.folder === 'media' ||
          info.folder === 'other'
      );
      if (replaceableAssets.length > 0) {
        for (const jsAsset of jsRecords) {
          try {
            let jsContent = fs.readFileSync(jsAsset.diskPath, 'utf8');
            let modified = false;
            for (const [remoteUrl, info] of replaceableAssets) {
              if (jsContent.includes(remoteUrl)) {
                jsContent = jsContent.split(remoteUrl).join(info.relativePath);
                modified = true;
              }
              try {
                const u = new URL(remoteUrl);
                if (u.pathname && u.pathname.length > 4 && jsContent.includes(u.pathname)) {
                  jsContent = jsContent.split(`"${u.pathname}"`).join(`"${info.relativePath}"`);
                  jsContent = jsContent.split(`'${u.pathname}'`).join(`'${info.relativePath}'`);
                  jsContent = jsContent.split(`\`${u.pathname}\``).join(`\`${info.relativePath}\``);
                  modified = true;
                }
              } catch {}
            }
            if (modified) {
              fs.writeFileSync(jsAsset.diskPath, jsContent, 'utf8');
              if (jsAsset.originalFilename && jsAsset.originalFilename !== jsAsset.filename) {
                const hashedCopy = path.join(siteDir, 'assets', 'js', jsAsset.filename);
                if (fs.existsSync(hashedCopy)) {
                  fs.writeFileSync(hashedCopy, jsContent, 'utf8');
                }
              }
            }
          } catch {}
        }
      }

      // Build Universal Offline VFS (`assets/js/__cloner_vfs.js`) for ES modules & 3D/Lottie binary assets
      hasVfs = buildUniversalOfflineVfs(siteDir, assetMap);
    }

    // Write final HTML files with VFS + Runtime Enhancer injected
    for (const pageItem of capturedPages) {
      const $ = pageItem.$;
      injectClonerRuntimeEnhancer($, hasVfs, pageItem.deferredModuleEntries || []);
      const outHtmlPath = path.join(siteDir, pageItem.filename);
      fs.writeFileSync(outHtmlPath, $.html(), 'utf8');
    }

    await context.close();
  } finally {
    await browser.close();
  }

  // Step 4: Package everything into a clean ZIP archive
  emitProgress({
    pct: 96,
    pages: capturedPages.length,
    assets: assetMap.size,
    title: 'Creating ZIP archive…',
    log: `Packaging ${capturedPages.length} page(s) and ${assetMap.size} assets into ${jobId}.zip`,
    type: 'step',
  });

  const zipBytes = await createZipArchive(siteDir, zipPath);
  const sizeFormatted = formatBytes(zipBytes);

  const summary = {
    id: jobId,
    url: startUrl,
    domain: rootUrlObj.hostname,
    mode,
    viewport,
    pagesCount: capturedPages.length,
    assetsCount: assetMap.size,
    sizeBytes: zipBytes,
    sizeFormatted,
    previewUrl: `/preview/${jobId}/index.html`,
    zipUrl: `/downloads/${jobId}.zip`,
    createdAt: new Date().toISOString(),
  };

  emitProgress({
    pct: 100,
    pages: capturedPages.length,
    assets: assetMap.size,
    title: 'Done! Your ZIP is ready.',
    log: `Completed! Cloned ${capturedPages.length} page(s) & ${assetMap.size} files (${sizeFormatted}).`,
    type: 'success',
    done: true,
    summary,
  });

  return summary;
}

module.exports = { runCloneJob };
