Your website copy — made with SiteClone
=======================================

Source  : {{URL}}
Pages   : {{PAGES}}
Saved   : {{DATE}}

HOW TO OPEN IT
--------------
1. Unzip this folder first (opening files from inside the ZIP does not work).

2. Easiest — just look at the pages:
     double-click  index.html

3. Everything working — animations, 3D, sliders, fonts, menus:
     Windows       : double-click  "Open website.bat"
     macOS / Linux : double-click  "Open website.command"
                     (macOS, first time: right-click > Open)
   A small window opens and your browser shows the site at http://localhost:8080.
   Keep that window open while you browse; close it to stop.
   Needs Node.js (https://nodejs.org) or Python 3 (https://www.python.org) — either one.

WHY THE LAUNCHER?
-----------------
Browsers treat files opened straight from your disk (file://...) as untrusted. They block
JavaScript modules, loading data with fetch(), many 3D/WebGL textures and some fonts.
That is why some sites look right but stay frozen when you open index.html directly.
The launcher serves the folder from your own computer (nothing goes online), so the
browser treats it like a normal website and everything runs.

Only download websites you own or are allowed to copy.
