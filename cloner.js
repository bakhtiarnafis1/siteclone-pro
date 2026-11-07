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

  // Keep SwiftShader / software WebGL active for lightweight canvases while capping Chromium memory for 512MB containers
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=192',
    '--renderer-process-limit=2',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
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
 * Auto-scroll the page smoothly to trigger lazy images, IntersectionObservers, and scroll animations.
 * Instantly skips scrolling on single-viewport (100vh) pages and enforces a strict 3.5s max timeout.
 */
async function autoScrollPage(page) {
  try {
    const metrics = await page
      .evaluate(() => ({
        totalHeight: Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        ),
        viewHeight: window.innerHeight || 900,
      }))
      .catch(() => ({ totalHeight: 0, viewHeight: 900 }));

    // Adaptive timeout: 0ms for single-screen 100vh pages, up to 10s for tall multi-section pages on slow CPUs
    const maxTimeoutMs =
      metrics.totalHeight <= metrics.viewHeight * 1.15
        ? 1200
        : Math.min(Math.max(Math.ceil(metrics.totalHeight / 900) * 900, 4500), 11000);

    await Promise.race([
      page.evaluate(async () => {
        // Force lazy images, videos, and iframes to eager load
        document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"], video[preload="none"]').forEach((el) => {
          if (el.tagName === 'VIDEO') el.setAttribute('preload', 'metadata');
          else el.setAttribute('loading', 'eager');
        });
        document.querySelectorAll('img[data-src], img[data-lazy-src], source[data-src]').forEach((el) => {
          const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src');
          if (dataSrc && !el.getAttribute('src')) {
            el.setAttribute('src', dataSrc);
          }
        });
        document.querySelectorAll('source[data-srcset], img[data-srcset]').forEach((el) => {
          const dataSrcset = el.getAttribute('data-srcset');
          if (dataSrcset && !el.getAttribute('srcset')) {
            el.setAttribute('srcset', dataSrcset);
          }
        });
        document.querySelectorAll('[data-bg], [data-background-image]').forEach((el) => {
          const bg = el.getAttribute('data-bg') || el.getAttribute('data-background-image');
          if (bg && (!el.style.backgroundImage || el.style.backgroundImage === 'none')) {
            el.style.backgroundImage = `url("${bg}")`;
          }
        });

        const totalHeight = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        const viewHeight = window.innerHeight || 900;

        // Fast-path: If this is a single-section / 100vh page (like Clara Studio), skip scrolling completely!
        if (totalHeight <= viewHeight * 1.15) {
          return false;
        }

        await new Promise((resolve) => {
          let currentScroll = 0;
          const step = 520;
          const maxScrollHeight = Math.min(
            Math.max(totalHeight, document.documentElement.scrollHeight || 0),
            25000
          );

          // Scroll down steadily so every IntersectionObserver / whileInView triggers all the way to the footer
          const downTimer = setInterval(() => {
            window.scrollBy(0, step);
            currentScroll += step;
            // Re-read scrollHeight in case lazy sections expanded the page
            const liveMax = Math.min(
              Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0),
              25000
            );
            if (currentScroll >= Math.max(maxScrollHeight, liveMax)) {
              clearInterval(downTimer);
              setTimeout(() => {
                // Scroll back up so sticky navbars reveal themselves
                window.scrollBy(0, -600);
                setTimeout(() => {
                  window.scrollTo(0, 0);
                  setTimeout(() => resolve(true), 220);
                }, 120);
              }, 200);
            }
          }, 65);
        });
        return true;
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), maxTimeoutMs)),
    ]);
  } catch {}
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
      // 0. Capture & preserve Web Animations API (`document.getAnimations()`)!
      //    - Infinite WAAPI loops (e.g. pulsing radar rings, floating icons) -> convert to native CSS @keyframes
      //      and commit safe opacity so scaled pulse rings NEVER freeze as giant solid opaque circles!
      //    - One-shot entrance animations -> finish & commit styles cleanly.
      try {
        if (typeof document.getAnimations === 'function') {
          const anims = document.getAnimations();
          const cssKeyframes = [];
          let kfIdx = 0;

          anims.forEach((anim) => {
            try {
              const effect = anim.effect;
              const target = effect && effect.target;
              if (!target || target.nodeType !== 1) return;
              // Skip native CSS animations that already come from stylesheets
              if (anim.animationName) return;

              const timing = typeof effect.getTiming === 'function' ? effect.getTiming() : {};
              const keyframes = typeof effect.getKeyframes === 'function' ? effect.getKeyframes() : [];

              if (timing.iterations === Infinity && keyframes.length >= 2) {
                const name = `__cloner_waapi_${kfIdx++}`;
                const steps = keyframes
                  .map((kf, i) => {
                    const pct =
                      kf.offset != null
                        ? Math.round(kf.offset * 100)
                        : Math.round((i / (keyframes.length - 1)) * 100);
                    const props = [];
                    if (kf.opacity != null) props.push(`opacity: ${kf.opacity}`);
                    if (kf.transform != null) props.push(`transform: ${kf.transform}`);
                    if (kf.filter != null) props.push(`filter: ${kf.filter}`);
                    return props.length ? `${pct}% { ${props.join('; ')}; }` : '';
                  })
                  .filter(Boolean)
                  .join(' ');

                if (steps) {
                  const dur = typeof timing.duration === 'number' && timing.duration > 0 ? timing.duration : 2000;
                  const dir = timing.direction || 'normal';
                  const ease = timing.easing || 'ease-in-out';
                  cssKeyframes.push(`@keyframes ${name} { ${steps} }`);
                  target.style.animation = `${name} ${dur}ms ${ease} 0ms infinite ${dir}`;
                  // Also commit safe resting opacity if WAAPI animates opacity down to 0 on a scaled ring
                  const cs = window.getComputedStyle(target);
                  if (cs && parseFloat(cs.opacity) < 0.35 && !target.style.opacity) {
                    target.style.opacity = cs.opacity;
                  }
                }
              } else if (timing.iterations && timing.iterations !== Infinity) {
                try {
                  anim.finish();
                  if (typeof anim.commitStyles === 'function') anim.commitStyles();
                } catch {}
              }
            } catch {}
          });

          if (cssKeyframes.length > 0 && document.head) {
            let kfStyle = document.getElementById('cloner-waapi-keyframes');
            if (!kfStyle) {
              kfStyle = document.createElement('style');
              kfStyle.id = 'cloner-waapi-keyframes';
              document.head.appendChild(kfStyle);
            }
            kfStyle.textContent = cssKeyframes.join('\n');
          }
        }
      } catch {}

      // 1. Fix corrupted inline styles (e.g. `background-image: ;` when shorthand uses CSS variables)
      document.querySelectorAll('[style]').forEach((el) => {
        let styleAttr = el.getAttribute('style') || '';
        const ssrStyle = el.getAttribute('data-cloner-init-style') || '';

        if (styleAttr.includes(': ;') || styleAttr.includes(':;')) {
          styleAttr = styleAttr.replace(/[a-z-]+\s*:\s*;\s*/gi, '');

          let restoredBg = '';
          if (ssrStyle) {
            const bgMatch = ssrStyle.match(/(?:^|;)\s*(background(?:-image|-color)?\s*:[^;]+)/i);
            if (bgMatch && bgMatch[1] && !bgMatch[1].includes('rgba(0, 0, 0, 0)')) {
              restoredBg = bgMatch[1].trim();
            }
          }

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
            styleAttr = styleAttr.replace(/background-color\s*:\s*rgba\(0,\s*0,\s*0,\s*0\)\s*;?/gi, '');
            styleAttr = `${styleAttr.replace(/;+\s*$/, '')}; ${restoredBg};`;
          }
          el.setAttribute('style', styleAttr.trim());
        }
      });

      // 2. Universal Scroll-Reveal / `whileInView` / GSAP / AOS / Elementor / Navigation Normalizer
      document
        .querySelectorAll('[style], [data-aos], [data-sr-id], .elementor-invisible, .wow')
        .forEach((el) => {
          const styleAttr = el.getAttribute('style') || '';
          const clsStr = typeof el.className === 'string' ? el.className : '';

          // Skip loaders, aria-hidden decorative backdrops, or Tailwind hover overlays (`group-hover:opacity-100`)
          if (
            clsStr.includes('loader') ||
            clsStr.includes('hover:opacity-') ||
            el.getAttribute('aria-hidden') === 'true' ||
            el.hasAttribute('hidden')
          ) {
            return;
          }

          // Reveal Elementor / AOS / WOW hidden classes
          if (el.classList && el.classList.contains('elementor-invisible')) {
            el.classList.remove('elementor-invisible');
          }

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

          // Restore vertical section timeline lines (`origin-top` + `scaleY(0)`) reset when scrolling back to top
          if (
            clsStr.includes('origin-top') &&
            styleAttr.includes('scaleY(0)') &&
            !clsStr.includes('fixed')
          ) {
            el.style.transform = 'scaleY(1)';
            return;
          }

          const isNav =
            el.tagName === 'NAV' ||
            el.tagName === 'HEADER' ||
            el.getAttribute('name') === 'Navigation' ||
            el.getAttribute('data-framer-name') === 'Navigation' ||
            Boolean(el.querySelector && el.querySelector('nav'));

          const hasExplicitAppearMarker =
            styleAttr.includes('will-change: transform') ||
            styleAttr.includes('will-change:transform') ||
            el.hasAttribute('data-framer-appear-id') ||
            el.hasAttribute('data-w-id') ||
            el.hasAttribute('data-aos') ||
            el.hasAttribute('data-sr-id') ||
            isNav;

          // Also catch Framer Motion v11/v12, GSAP, & ScrollReveal inline `opacity: 0` content blocks WITHOUT `will-change`!
          const opVal = el.style.opacity !== '' ? parseFloat(el.style.opacity) : 1;
          const hasRealContent =
            (el.innerText && el.innerText.trim().length > 0) ||
            Boolean(
              el.querySelector &&
                el.querySelector('img, svg, input, textarea, select, button, form, video, iframe, canvas')
            );
          const isHiddenMotionContent =
            opVal <= 0.12 &&
            hasRealContent &&
            !clsStr.includes('pointer-events-none') &&
            (styleAttr.includes('transform') ||
              styleAttr.includes('translate') ||
              styleAttr.includes('scale') ||
              el.tagName === 'SECTION' ||
              el.tagName === 'H1' ||
              el.tagName === 'H2' ||
              el.tagName === 'H3' ||
              el.tagName === 'P' ||
              el.tagName === 'DIV' ||
              el.tagName === 'LI' ||
              el.tagName === 'FORM');

          if (hasExplicitAppearMarker || isHiddenMotionContent) {
            const threshold = hasExplicitAppearMarker ? 0.5 : 0.12;
            if (el.style.opacity !== '' && opVal <= threshold) {
              el.style.opacity = '1';
            }
            if (el.style.visibility === 'hidden') {
              el.style.visibility = 'visible';
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

      // 5. Hide loading overlays (e.g. `.loader`, `.loader.is-done`) and remove `.stage-fallback` so 3D VFS boots cleanly
      document.querySelectorAll('.loader, .loader.is-done, [class*="loader"][class*="done"]').forEach((loader) => {
        loader.classList.add('is-done');
        loader.style.opacity = '0';
        loader.style.pointerEvents = 'none';
        loader.style.display = 'none';
      });
      document.querySelectorAll('.stage-fallback').forEach((fb) => fb.remove());

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
  if (matches.length === 0) return cssText;

  // Pre-fetch all uncached CSS url(...) assets concurrently in parallel for 10x speed
  if (saveAssetFromUrl) {
    const missingUrls = new Set();
    for (const match of matches) {
      const rawRef = (match[2] || '').trim();
      if (!rawRef || rawRef.startsWith('data:') || rawRef.startsWith('#')) continue;
      try {
        const resolvedUrl = new URL(rawRef, cssBaseUrl).toString();
        if (!assetMap.has(resolvedUrl)) {
          missingUrls.add(resolvedUrl);
        }
      } catch {}
    }
    if (missingUrls.size > 0) {
      await Promise.all([...missingUrls].map((u) => saveAssetFromUrl(u).catch(() => null)));
    }
  }

  let updatedCss = cssText;
  for (const match of matches) {
    const fullMatch = match[0];
    const rawRef = (match[2] || '').trim();
    if (!rawRef || rawRef.startsWith('data:') || rawRef.startsWith('#')) continue;

    try {
      const resolvedUrl = new URL(rawRef, cssBaseUrl).toString();
      const assetInfo = assetMap.get(resolvedUrl);
      if (assetInfo) {
        // Inline webfont files (<= 350KB) as data: URIs so Chrome/Edge file:// NEVER blocks custom fonts with origin 'null' CORS!
        if (assetInfo.folder === 'fonts' && assetInfo.diskPath) {
          if (!assetInfo.dataUri) {
            try {
              const stat = fs.statSync(assetInfo.diskPath);
              if (stat.size > 0 && stat.size <= 350 * 1024) {
                const ext = path.extname(assetInfo.diskPath).toLowerCase();
                const mime =
                  ext === '.woff2'
                    ? 'font/woff2'
                    : ext === '.woff'
                    ? 'font/woff'
                    : ext === '.ttf'
                    ? 'font/ttf'
                    : ext === '.otf'
                    ? 'font/otf'
                    : 'font/woff2';
                assetInfo.dataUri = `data:${mime};base64,${fs.readFileSync(assetInfo.diskPath).toString('base64')}`;
              }
            } catch {}
          }
          if (assetInfo.dataUri) {
            updatedCss = updatedCss.split(fullMatch).join(`url("${assetInfo.dataUri}")`);
            continue;
          }
        }

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
function buildUniversalOfflineVfs(siteDir, assetMap, includeEsModules = true) {
  try {
    const jsDir = path.join(siteDir, 'assets', 'js');
    const otherDir = path.join(siteDir, 'assets', 'other');
    const vfsPath = path.join(jsDir, '__cloner_vfs.js');

    const modules = {};
    if (includeEsModules && fs.existsSync(jsDir)) {
      for (const file of fs.readdirSync(jsDir)) {
        if ((file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.framercms')) && !file.startsWith('__cloner')) {
          try {
            const fullPath = path.join(jsDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.size <= 5 * 1024 * 1024) {
              modules[file] = fs.readFileSync(fullPath, 'utf8');
            }
          } catch {}
        }
      }
    }

    // Build Universal Asset Redirect Map (`window.__CLONER_ASSET_MAP__`) so hydrated Next.js (`next/image`, `next/font`, Turbopack/Webpack chunks),
    // React, Nuxt, Vue, SvelteKit, and Astro resolve root-relative & dynamic URLs straight to local downloaded files on `file://`!
    const urlMap = {};
    for (const [remoteUrl, info] of assetMap.entries()) {
      const rel = info.relativePath;
      urlMap[remoteUrl] = rel;
      try {
        const u = new URL(remoteUrl);
        if (u.pathname) {
          urlMap[u.pathname + (u.search || '')] = rel;
          if (!urlMap[u.pathname]) {
            urlMap[u.pathname] = rel;
          }
          // Map Next.js `/_next/image?url=%2Ffoo.png&w=...` decoded inner `url` parameter so ANY responsive width `w=` resolves offline!
          if (u.pathname.includes('/_next/image') && u.searchParams.has('url')) {
            const innerUrl = u.searchParams.get('url');
            if (innerUrl) {
              urlMap[innerUrl] = rel;
            }
          }
          // Map Next.js / Webpack partial static paths (`static/chunks/...`, `static/media/...`)
          const nextIdx = u.pathname.indexOf('/_next/');
          if (nextIdx !== -1) {
            urlMap[u.pathname.slice(nextIdx + '/_next/'.length)] = rel;
          }
        }
      } catch {}
    }

    // Write modules + universal asset map first, then stream each binary asset ONCE with lightweight pointer aliases
    fs.writeFileSync(
      vfsPath,
      `window.__CLONER_ASSET_MAP__ = ${JSON.stringify(urlMap)};\nwindow.__CLONER_MODULES__ = ${JSON.stringify(modules)};\nwindow.__CLONER_BINARY_ASSETS__ = {};\n`,
      'utf8'
    );

    let binaryCount = 0;
    const storedFiles = new Set();
    if (fs.existsSync(otherDir)) {
      for (const file of fs.readdirSync(otherDir)) {
        try {
          const fullPath = path.join(otherDir, file);
          const stat = fs.statSync(fullPath);
          if (stat.size <= 20 * 1024 * 1024) {
            const b64 = fs.readFileSync(fullPath).toString('base64');
            const keyLit = JSON.stringify(file);
            const relLit = JSON.stringify(`assets/other/${file}`);
            fs.appendFileSync(
              vfsPath,
              `window.__CLONER_BINARY_ASSETS__[${keyLit}] = "${b64}";\nwindow.__CLONER_BINARY_ASSETS__[${relLit}] = window.__CLONER_BINARY_ASSETS__[${keyLit}];\n`,
              'utf8'
            );
            storedFiles.add(file);
            binaryCount++;
          }
        } catch {}
      }
    }

    // Map original remote URLs and root-relative pathnames (e.g. "/models/clara-rigged.glb") by reference (0 extra bytes!)
    const aliasLines = [];
    for (const [remoteUrl, info] of assetMap.entries()) {
      if (info.folder === 'other') {
        const primaryFile = info.originalFilename || info.filename;
        if (storedFiles.has(primaryFile)) {
          const targetRef = `window.__CLONER_BINARY_ASSETS__[${JSON.stringify(primaryFile)}]`;
          aliasLines.push(`window.__CLONER_BINARY_ASSETS__[${JSON.stringify(remoteUrl)}] = ${targetRef};`);
          try {
            const u = new URL(remoteUrl);
            if (u.pathname) {
              aliasLines.push(`window.__CLONER_BINARY_ASSETS__[${JSON.stringify(u.pathname)}] = ${targetRef};`);
            }
          } catch {}
        }
      }
    }
    if (aliasLines.length > 0) {
      fs.appendFileSync(vfsPath, aliasLines.join('\n') + '\n', 'utf8');
    }

    return Object.keys(urlMap).length > 0 || Object.keys(modules).length > 0 || binaryCount > 0;
  } catch {
    return false;
  }
}

/**
 * Inject a lightweight CSS + JS runtime guard + Universal VFS / Framework Hydration Bootloader into cloned HTML pages so:
 * 1. Next.js 13/14/15/16 (Turbopack & Webpack), React, Nuxt, SvelteKit & Astro hydrate cleanly on `file://` (`data-cloner-orig-src`, `next/image` & `next/font` virtualizers)
 * 2. `<script type="module">` and dynamic `import()` run with 0 CORS errors on `file://` via Blob URLs + `<script type="importmap">`
 * 3. 3D WebGL models (`.glb`, `.gltf`, `.splinecode`, `.wasm`) load via in-memory `fetch`/`XHR` VFS on `file://`
 * 4. Sticky navbars, scroll-linked sections, WAAPI pulses, ticker backgrounds, and button gradients stay 100% intact.
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
  var assetMap = window.__CLONER_ASSET_MAP__ || {};

  // Universal URL Resolver for Next.js (next/image, next/font, Turbopack/Webpack chunks), Vite, Nuxt & SPA assets
  function resolveClonerUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('assets/')) return null;
    if (assetMap[rawUrl]) return assetMap[rawUrl];
    try {
      // Handle Next.js /_next/image?url=%2F...&w=... for any responsive width
      if (rawUrl.indexOf('/_next/image') !== -1 && rawUrl.indexOf('url=') !== -1) {
        var qIdx = rawUrl.indexOf('?');
        if (qIdx !== -1) {
          var params = new URLSearchParams(rawUrl.slice(qIdx + 1));
          var inner = params.get('url');
          if (inner && assetMap[inner]) return assetMap[inner];
        }
      }
      var noHash = rawUrl.split('#')[0];
      if (assetMap[noHash]) return assetMap[noHash];
      var cleanPath = noHash.split('?')[0];
      if (assetMap[cleanPath]) return assetMap[cleanPath];
    } catch (e) {}
    return null;
  }
  window.__resolveClonerUrl = resolveClonerUrl;

  // 1. Safe History pushState/replaceState wrapper on file:// so SPA routers never crash with SecurityError
  if (window.location.protocol === 'file:') {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function() { try { return origPush.apply(this, arguments); } catch (e) {} };
    history.replaceState = function() { try { return origReplace.apply(this, arguments); } catch (e) {} };
  }

  // 2. Virtualize <script>, <link>, and <img> attributes/properties so Next.js Turbopack/Webpack chunks & next/image work live on file://!
  try {
    var origGetAttr = Element.prototype.getAttribute;
    var origSetAttr = Element.prototype.setAttribute;

    Element.prototype.getAttribute = function(name) {
      if (name === 'src' && this.tagName === 'SCRIPT') {
        var origSrc = origGetAttr.call(this, 'data-cloner-orig-src');
        if (origSrc) return origSrc;
      }
      if (name === 'href' && this.tagName === 'LINK') {
        var origHref = origGetAttr.call(this, 'data-cloner-orig-href');
        if (origHref) return origHref;
      }
      return origGetAttr.call(this, name);
    };

    Element.prototype.setAttribute = function(name, value) {
      if (typeof value === 'string') {
        if (this.tagName === 'IMG' || this.tagName === 'SOURCE') {
          if (name === 'src') {
            var mappedImg = resolveClonerUrl(value);
            if (mappedImg) return origSetAttr.call(this, 'src', mappedImg);
            // Prevent broken root-relative /_next/image paths from overwriting an already-valid local image
            if (value.charAt(0) === '/' && (origGetAttr.call(this, 'src') || '').indexOf('assets/') === 0) return;
          } else if (name === 'srcset' || name === 'srcSet') {
            if (value.indexOf('/_next/') !== -1 || value.charAt(0) === '/') {
              var firstCand = value.split(',')[0].trim().split(/\\s+/)[0];
              var mappedSet = resolveClonerUrl(firstCand);
              if (mappedSet) {
                origSetAttr.call(this, 'src', mappedSet);
              }
              return;
            }
          }
        } else if (this.tagName === 'SCRIPT' && name === 'src') {
          var mappedJs = resolveClonerUrl(value);
          if (mappedJs) {
            origSetAttr.call(this, 'data-cloner-orig-src', value);
            return origSetAttr.call(this, 'src', mappedJs);
          }
        } else if (this.tagName === 'LINK' && name === 'href') {
          var mappedCss = resolveClonerUrl(value);
          if (mappedCss) {
            origSetAttr.call(this, 'data-cloner-orig-href', value);
            return origSetAttr.call(this, 'href', mappedCss);
          }
        }
      }
      return origSetAttr.call(this, name, value);
    };

    // Virtualize HTMLScriptElement.prototype.src (fixes Next.js Expected document.currentScript src to contain '/_next/' invariant!)
    var scriptSrcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (scriptSrcDesc && scriptSrcDesc.get && scriptSrcDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        get: function() {
          var raw = scriptSrcDesc.get.call(this);
          var origSrc = origGetAttr.call(this, 'data-cloner-orig-src');
          if (origSrc && origSrc.indexOf('/_next/') !== -1 && raw && raw.indexOf('/assets/js/') !== -1) {
            var idx = raw.indexOf('/assets/js/');
            return raw.slice(0, idx) + origSrc;
          }
          return raw;
        },
        set: function(val) {
          var mapped = resolveClonerUrl(String(val));
          if (mapped) {
            origSetAttr.call(this, 'data-cloner-orig-src', String(val));
            return scriptSrcDesc.set.call(this, mapped);
          }
          return scriptSrcDesc.set.call(this, val);
        },
        configurable: true
      });
    }

    // Virtualize HTMLImageElement.prototype.src & srcset setters for React / Next.js hydration
    var imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (imgSrcDesc && imgSrcDesc.set && imgSrcDesc.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: imgSrcDesc.get,
        set: function(val) {
          var sVal = String(val || '');
          var mapped = resolveClonerUrl(sVal);
          if (mapped) return imgSrcDesc.set.call(this, mapped);
          if (sVal.charAt(0) === '/' && (origGetAttr.call(this, 'src') || '').indexOf('assets/') === 0) return;
          return imgSrcDesc.set.call(this, val);
        },
        configurable: true
      });
    }
    var imgSrcsetDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
    if (imgSrcsetDesc && imgSrcsetDesc.set && imgSrcsetDesc.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
        get: imgSrcsetDesc.get,
        set: function(val) {
          var sVal = String(val || '');
          if (sVal.indexOf('/_next/') !== -1 || sVal.charAt(0) === '/') {
            var firstCand = sVal.split(',')[0].trim().split(/\\s+/)[0];
            var mapped = resolveClonerUrl(firstCand);
            if (mapped && imgSrcDesc && imgSrcDesc.set) {
              imgSrcDesc.set.call(this, mapped);
            }
            return;
          }
          return imgSrcsetDesc.set.call(this, val);
        },
        configurable: true
      });
    }
    // Suppress dynamic file:// preload links (e.g. React 19 ReactDOM.preload font/fetch/modulepreload) that trigger null-origin CORS
    if (window.location.protocol === 'file:') {
      var shouldSkipLink = function(node) {
        if (!node || node.nodeType !== 1 || node.tagName !== 'LINK') return false;
        var rel = (origGetAttr.call(node, 'rel') || '').toLowerCase();
        var asAttr = (origGetAttr.call(node, 'as') || '').toLowerCase();
        return (
          rel === 'modulepreload' ||
          (rel === 'preload' && (asAttr === 'font' || asAttr === 'fetch' || asAttr === 'script'))
        );
      };
      var origAppendChild = Node.prototype.appendChild;
      var origInsertBefore = Node.prototype.insertBefore;
      Node.prototype.appendChild = function(child) {
        if (shouldSkipLink(child)) return child;
        return origAppendChild.call(this, child);
      };
      Node.prototype.insertBefore = function(child, refNode) {
        if (shouldSkipLink(child)) return child;
        return origInsertBefore.call(this, child, refNode);
      };
    }
  } catch (e) {}

  // 2b. Smart IntersectionObserver Stabilizer & Event-Driven Auto-Reveal for Framer Motion whileInView, GSAP, AOS & ScrollReveal:
  //     - Triggers directly from observe(el) regardless of when React/Next/Nuxt chunks finish hydrating!
  //     - Prevents revealed sections from reverting to opacity: 0 when scrolled out of view (once: false -> once: true)
  if (typeof window.IntersectionObserver === 'function') {
    try {
      var NativeIO = window.IntersectionObserver;
      var WrappedIO = function(callback, options) {
        var pendingEls = new Set();
        var revealTimer = null;
        var record = { cb: callback, instance: null };

        var flushPending = function() {
          revealTimer = null;
          if (pendingEls.size === 0) return;
          var nowTs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
          var vpRect = {
            top: 0,
            left: 0,
            bottom: window.innerHeight || 900,
            right: window.innerWidth || 1440,
            width: window.innerWidth || 1440,
            height: window.innerHeight || 900,
            x: 0,
            y: 0
          };
          var synthEntries = [];
          pendingEls.forEach(function(el) {
            if (el && el.isConnected) {
              var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : vpRect;
              synthEntries.push({
                target: el,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: vpRect,
                time: nowTs
              });
            }
          });
          pendingEls.clear();
          if (synthEntries.length > 0) {
            try { record.cb.call(record.instance, synthEntries, record.instance); } catch (err) {}
          }
        };

        var nativeObs = new NativeIO(function(entries) {
          var filtered = [];
          for (var i = 0; i < entries.length; i++) {
            var ent = entries[i];
            if (ent.isIntersecting) {
              if (ent.target) ent.target.__clonerRevealed = true;
              filtered.push(ent);
            } else if (!ent.target || !ent.target.__clonerRevealed) {
              filtered.push(ent);
            }
          }
          if (filtered.length > 0) {
            try { callback.call(record.instance, filtered, record.instance); } catch (err) {}
          }
        }, options);

        var wrapper = {
          root: nativeObs.root,
          rootMargin: nativeObs.rootMargin,
          thresholds: nativeObs.thresholds,
          observe: function(el) {
            if (el && el.nodeType === 1) {
              el.__clonerRevealed = true;
              pendingEls.add(el);
              if (!revealTimer) {
                revealTimer = setTimeout(flushPending, 60);
              }
            }
            return nativeObs.observe(el);
          },
          unobserve: function(el) {
            pendingEls.delete(el);
            return nativeObs.unobserve(el);
          },
          disconnect: function() {
            pendingEls.clear();
            if (revealTimer) {
              clearTimeout(revealTimer);
              revealTimer = null;
            }
            return nativeObs.disconnect();
          },
          takeRecords: function() {
            return nativeObs.takeRecords();
          }
        };
        record.instance = wrapper;
        return wrapper;
      };
      WrappedIO.prototype = NativeIO.prototype;
      window.IntersectionObserver = WrappedIO;
    } catch (e) {}
  }

  // 3. Intercept fetch() & XMLHttpRequest for 3D models (.glb, .gltf, .splinecode, .wasm, .bin) & SPA routers on file://
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
      var urlStr = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input || '');
      var b64 = matchVfsAsset(urlStr);
      if (b64) {
        var bytes = decodeBase64ToBytes(b64);
        return Promise.resolve(new Response(bytes.buffer, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) }
        }));
      }
      // Prevent Next.js RSC flight or Pages Router _next/data prefetches from throwing network/CORS errors on file://
      if (window.location.protocol === 'file:') {
        if (urlStr.indexOf('_rsc=') !== -1) {
          return Promise.resolve(new Response('', { status: 200 }));
        }
        if (urlStr.indexOf('/_next/data/') !== -1) {
          return Promise.resolve(new Response('{"pageProps":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
      }
      return origFetch.apply(this, arguments);
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    var origXhrOpen = XMLHttpRequest.prototype.open;
    var origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__clonerUrl = typeof url === 'string' ? url : (url && url.href) || String(url || '');
      return origXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      var b64 = matchVfsAsset(this.__clonerUrl);
      if (b64) {
        var self = this;
        var bytes = decodeBase64ToBytes(b64);
        setTimeout(function() {
          try {
            Object.defineProperty(self, 'status', { value: 200, configurable: true });
            Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
            var respVal = self.responseType === 'blob' ? new Blob([bytes]) : bytes.buffer;
            Object.defineProperty(self, 'response', { value: respVal, configurable: true });
            if (typeof self.onload === 'function') self.onload(new Event('load'));
            self.dispatchEvent(new Event('load'));
            if (typeof self.onreadystatechange === 'function') self.onreadystatechange(new Event('readystatechange'));
          } catch (err) {}
        }, 0);
        return;
      }
      return origXhrSend.apply(this, arguments);
    };
  }

  // 4. Build Blob URLs + ImportMap for ES modules so <script type="module"> & dynamic import() run on file:// with zero CORS errors
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
        var escapedOther = other.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
        var crossDirRe = new RegExp('(["\\\'\\\`])(?:\\.\\.?\\/[\\\\w./-]*\\/|\\/[\\\\w./-]*\\/)' + escapedOther + '\\\\1', 'g');
        code = code.replace(crossDirRe, '$1@cloner/' + other + '$1');
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
  // 1. Snapshot clean button styles, local images, rewritten local .html links, and pre-rendered SPA root before hydration
  var savedStyles = new WeakMap();
  var savedHrefs = new WeakMap();
  var savedImgSrcs = new WeakMap();
  var savedRootHtml = '';

  function snapshotCleanDom() {
    var rootEl = document.getElementById('root') || document.getElementById('app') || document.getElementById('__next');
    if (rootEl && rootEl.innerHTML.trim().length > 100 && !savedRootHtml) {
      savedRootHtml = rootEl.innerHTML;
    }
    document.querySelectorAll('img[src^="assets/"]').forEach(function(img) {
      savedImgSrcs.set(img, img.getAttribute('src'));
    });
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

    // Repair any <img> whose src was overwritten with a root-relative /... or /_next/image path during hydration
    document.querySelectorAll('img').forEach(function(img) {
      var rawSrc = img.getAttribute('src') || '';
      if (rawSrc.charAt(0) === '/') {
        var resolved = window.__resolveClonerUrl ? window.__resolveClonerUrl(rawSrc) : null;
        if (resolved) {
          img.setAttribute('src', resolved);
          img.removeAttribute('srcset');
        } else if (savedImgSrcs.has(img)) {
          img.setAttribute('src', savedImgSrcs.get(img));
          img.removeAttribute('srcset');
        }
      }
    });

    // Rewrite any dynamically-injected <style> tag (e.g. next/font / styled-jsx) referencing /_next/static/media/...
    if (window.__resolveClonerUrl) {
      document.querySelectorAll('style:not([data-cloner-checked])').forEach(function(stEl) {
        var txt = stEl.textContent || '';
        if (txt.indexOf('/_next/') !== -1 || txt.indexOf('url(/') !== -1) {
          var replaced = txt.replace(/url\\((['"]?)(\\/[^'")]+)\\1\\)/g, function(full, q, ref) {
            var loc = window.__resolveClonerUrl(ref);
            return loc ? 'url("' + loc + '")' : full;
          });
          if (replaced !== txt) stEl.textContent = replaced;
        }
        stEl.setAttribute('data-cloner-checked', '1');
      });
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

  // Observe and repair while hydration/scroll settles
  var obs = new MutationObserver(function() {
    repairHydrationArtifacts();
  });
  if (document.documentElement) {
    obs.observe(document.documentElement, { attributes: true, childList: true, subtree: true, attributeFilter: ['style', 'href', 'src'] });
  }
  window.addEventListener('scroll', repairHydrationArtifacts, { passive: true });
})();
</script>`;

  // Prepend VFS bootloader at the VERY TOP of <head> so shims execute BEFORE any Next.js / Webpack / Vite <script> tag!
  if ($('head').length) {
    $('head').prepend(vfsBootHead);
    $('head').append(runtimeCss);
  } else {
    $.root().prepend(vfsBootHead + runtimeCss);
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

  // Helper to save an asset buffer to disk (defined outside browser block so it works after browser.close())
  const saveBufferAsAsset = (assetUrl, buffer, contentType = '') => {
    if (!saveAssets || !buffer || buffer.length === 0) return null;
    if (assetMap.has(assetUrl)) return assetMap.get(assetUrl);

    const classified = classifyAsset(assetUrl, contentType);
    if (!classified) return null;

    const primaryFilename = classified.originalFilename || classified.filename;
    const diskPath = path.join(siteDir, 'assets', classified.folder, primaryFilename);
    try {
      fs.writeFileSync(diskPath, buffer);
      // Only write hashed duplicate for small JS modules (< 1MB) where both names may be referenced
      if (
        classified.folder === 'js' &&
        buffer.length <= 1024 * 1024 &&
        classified.originalFilename &&
        classified.originalFilename !== classified.filename
      ) {
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

  const failedAssetUrls = new Set();
  const deferredBinaryUrls = new Set();

  // Helper to fetch & save an asset URL using native Node.js fetch (works even after Chromium is closed!)
  const fetchAndSaveAsset = async (assetUrl, timeoutMs = 8000) => {
    if (!saveAssets || !assetUrl || assetUrl.startsWith('data:') || assetUrl.startsWith('blob:')) {
      return null;
    }
    if (assetMap.has(assetUrl)) return assetMap.get(assetUrl);
    if (failedAssetUrls.has(assetUrl)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      };
      if (cookies && cookies.trim()) {
        headers.Cookie = cookies.trim();
      }
      const res = await fetch(assetUrl, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        failedAssetUrls.add(assetUrl);
        return null;
      }
      const contentType = res.headers.get('content-type') || '';
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      return saveBufferAsAsset(assetUrl, buffer, contentType);
    } catch {
      clearTimeout(timer);
      failedAssetUrls.add(assetUrl);
      return null;
    }
  };

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

    const page = await context.newPage();

    // Defer heavy 3D/WebGL binary files (.glb, .gltf, .splinecode, .hdr, .bin, .wasm) out of headless SwiftShader
    // so 512MB containers never OOM-crash or freeze unpacking 15MB 3D meshes on CPU; Node.js downloads them directly after browser.close()!
    await page.route(/\.(glb|gltf|splinecode|hdr|bin|wasm|lottie|rive)(\?.*)?$/i, async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith('http')) {
        deferredBinaryUrls.add(reqUrl);
      }
      // Hold request briefly while DOM settles so SPA doesn't flash an error state before page.content() is captured
      await new Promise((r) => setTimeout(r, 2500));
      try {
        await route.abort();
      } catch {}
    });

    // Intercept all network responses to save exact CSS, JS, Fonts & Images loaded by the browser
    page.on('response', async (response) => {
      try {
        if (!saveAssets) return;
        const reqUrl = response.url();
        if (!reqUrl.startsWith('http') || assetMap.has(reqUrl) || deferredBinaryUrls.has(reqUrl)) return;
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
          timeout: 22000,
        });

        // Wait up to 1.4s for window 'load' or initial network burst, then 500ms for React/Next/Framer hydration
        await page.waitForLoadState('load', { timeout: 1400 }).catch(() => {});
        await page.waitForTimeout(500);

        if (autoScroll) {
          emitProgress({
            pct: Math.min(basePct + 4, 78),
            pages: pageIndex + 1,
            assets: assetMap.size,
            title: `Scrolling page ${pageIndex + 1} for lazy content & animations…`,
            log: `Checking lazy content & scroll animations on ${localFilename}`,
            type: 'info',
          });
          await autoScrollPage(page);
        }

        // Normalize DOM styles & capture lightweight 2D canvases
        await page.waitForTimeout(200);
        await inlineDynamicCssomStyles(page);
        if (deferredBinaryUrls.size === 0) {
          await captureCanvasSnapshots(page, saveBufferAsAsset, currentUrl);
        }
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

    await context.close().catch(() => {});
  } finally {
    // Close Chromium IMMEDIATELY after Step 1 so 150-200MB of RAM is freed before DOM processing, 3D downloads & VFS bundling!
    await browser.close().catch(() => {});
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
        // 0. Batch pre-fetch all uncached page assets concurrently in parallel (cuts Step 2 from ~23s to ~1.5s!)
        const missingDomUrls = new Set();
        const queueCandidateUrl = (raw) => {
          if (!raw || typeof raw !== 'string') return;
          const trimmed = raw.trim();
          if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) return;
          try {
            const abs = new URL(trimmed, basePageUrl).toString();
            if (!assetMap.has(abs) && !failedAssetUrls.has(abs)) {
              missingDomUrls.add(abs);
            }
          } catch {}
        };

        const resourceLinks = $(
          'link[rel="stylesheet"][href], link[as="style"][href], link[rel="modulepreload"][href], link[rel="preload"][href]'
        ).toArray();
        const imgElements = $('img, source, image, video, audio').toArray();
        const scriptElements = $('script[src]').toArray();
        const iconLinks = $('link[rel*="icon"][href]').toArray();

        resourceLinks.forEach((el) => queueCandidateUrl($(el).attr('href')));
        imgElements.forEach((el) => {
          queueCandidateUrl($(el).attr('poster'));
          const s = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('href') || $(el).attr('xlink:href');
          if (s) {
            queueCandidateUrl(s);
          } else if ($(el).attr('srcset')) {
            const firstSrc = ($(el).attr('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
            queueCandidateUrl(firstSrc);
          }
        });
        scriptElements.forEach((el) => queueCandidateUrl($(el).attr('src')));
        iconLinks.forEach((el) => queueCandidateUrl($(el).attr('href')));

        if (missingDomUrls.size > 0) {
          const urlList = [...missingDomUrls];
          const batchSize = 12;
          for (let i = 0; i < urlList.length; i += batchSize) {
            await Promise.all(urlList.slice(i, i + batchSize).map((u) => fetchAndSaveAsset(u).catch(() => null)));
          }
        }

        // 1. Stylesheets & Modulepreload / Preload links (<link rel="stylesheet|modulepreload|preload" href="...">)
        for (const el of resourceLinks) {
          const href = $(el).attr('href');
          if (!href || href.startsWith('data:')) continue;
          try {
            const absUrl = new URL(href, basePageUrl).toString();
            const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
            if (saved && rewriteLinks) {
              $(el).attr('data-cloner-orig-href', href);
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

        // 2. Images, Videos, Audio & SVG <image> (<img src="...">, <video poster="...">, <audio src="...">)
        for (const el of imgElements) {
          const poster = $(el).attr('poster');
          if (poster && !poster.startsWith('data:')) {
            try {
              const absPoster = new URL(poster, basePageUrl).toString();
              const savedPoster = assetMap.get(absPoster) || (await fetchAndSaveAsset(absPoster));
              if (savedPoster && rewriteLinks) {
                $(el).attr('poster', savedPoster.relativePath);
              }
            } catch {}
          }

          const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('href') || $(el).attr('xlink:href');
          if (src && !src.startsWith('data:')) {
            try {
              const absUrl = new URL(src, basePageUrl).toString();
              const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
              if (saved && rewriteLinks) {
                if ($(el).attr('href')) $(el).attr('href', saved.relativePath);
                else if ($(el).attr('xlink:href')) $(el).attr('xlink:href', saved.relativePath);
                else $(el).attr('src', saved.relativePath);
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
                  if ((el.tagName || '').toLowerCase() === 'source' && $(el).parent().is('picture')) {
                    $(el).attr('srcset', saved.relativePath);
                  } else {
                    $(el).attr('src', saved.relativePath);
                    $(el).removeAttr('srcset');
                  }
                }
              } catch {}
            }
          }
        }

        // 3. Scripts (<script src="...">)
        const deferredModuleEntries = [];
        for (const el of scriptElements) {
          const src = $(el).attr('src');
          if (!src || src.startsWith('data:')) continue;
          try {
            const absUrl = new URL(src, basePageUrl).toString();
            const saved = assetMap.get(absUrl) || (await fetchAndSaveAsset(absUrl));
            if (saved && rewriteLinks) {
              $(el).attr('data-cloner-orig-src', src);
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

        // Remove <link rel="preload" as="fetch|font|script"> or <link rel="modulepreload"> that fail under file:// CORS
        $('link[rel="preload"][as="fetch"], link[rel="preload"][as="font"], link[rel="preload"][as="script"], link[rel="modulepreload"]').remove();

        // 4. Favicons (<link rel="icon" href="...">)
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
        pct: 88,
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

      // Scan downloaded JS/MJS bundles for any 3D/WebGL/Lottie asset paths (e.g. "/models/clara-rigged.glb")
      const jsRecords = [...assetMap.values()].filter(
        (a) => a.folder === 'js' && (a.diskPath.endsWith('.js') || a.diskPath.endsWith('.mjs'))
      );
      const modelPathRegex = /["'`]((?:https?:\/\/[^"'`\s]+|\/[a-zA-Z0-9_./-]+)\.(?:glb|gltf|splinecode|hdr|bin|wasm|lottie|rive))["'`]/gi;
      for (const jsAsset of jsRecords) {
        try {
          const jsText = fs.readFileSync(jsAsset.diskPath, 'utf8');
          for (const m of jsText.matchAll(modelPathRegex)) {
            const rawRef = m[1];
            if (rawRef) {
              try {
                const absModelUrl = new URL(rawRef, rootOrigin).toString();
                deferredBinaryUrls.add(absModelUrl);
              } catch {}
            }
          }
        } catch {}
      }

      // Download all deferred 3D / binary assets directly via Node.js fetch (now that Chromium is closed & RAM is free!)
      if (deferredBinaryUrls.size > 0) {
        for (const binUrl of deferredBinaryUrls) {
          await fetchAndSaveAsset(binUrl, 18000);
        }
      }

      // Rewrite already-captured remote & root-relative image/font/media/3D URLs inside JS/MJS bundles
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

      // Build Universal Offline VFS (`assets/js/__cloner_vfs.js`) for Asset Map, ES modules & 3D/Lottie binary assets
      const needsEsModuleBundle =
        capturedPages.some((p) => (p.deferredModuleEntries || []).length > 0) ||
        [...assetMap.values()].some(
          (a) => a.diskPath.endsWith('.mjs') || a.diskPath.endsWith('.framercms')
        );
      hasVfs = buildUniversalOfflineVfs(siteDir, assetMap, needsEsModuleBundle);
    }

    // Write final HTML files with VFS + Runtime Enhancer injected
    for (const pageItem of capturedPages) {
      const $ = pageItem.$;
      injectClonerRuntimeEnhancer($, hasVfs, pageItem.deferredModuleEntries || []);
      const outHtmlPath = path.join(siteDir, pageItem.filename);
      fs.writeFileSync(outHtmlPath, $.html(), 'utf8');
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
    zipUrl: `/downloads/${jobId}.zip?url=${encodeURIComponent(startUrl)}`,
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

module.exports = { runCloneJob, createZipArchive };
