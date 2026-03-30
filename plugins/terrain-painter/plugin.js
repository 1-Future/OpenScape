(function(exports) {
  exports.meta = {
    id: 'terrain-painter',
    name: 'Terrain Painter',
    version: '1.0.0',
    depends: [],
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  SERVER — paint/bucket message handlers already exist in engine core.
  //  This plugin just initializes cleanly on the server side.
  // ═══════════════════════════════════════════════════════════════════════════
  exports.server = {
    api: {},
    init(engine) {
      console.log('[terrain-painter] Server ready');
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  CLIENT — Pencil, Bucket, Eyedropper tools + texture browser panel
  // ═══════════════════════════════════════════════════════════════════════════
  exports.client = {
    api: {},
    init(engine) {
      const T = engine.T;
      let paintTile = T.GRASS;
      let paintVariant = 0;
      let customBrushColor = '#8B7355';
      let painting = false;
      const painted = new Set();

      // ── Pencil Tool ──────────────────────────────────────────────────
      engine.registerTool({
        id: 'pencil',
        name: 'Pencil',
        icon: 'P',
        category: 'terrain',
        cursor: 'cell',
        keybind: { action: 'tool.pencil', key: 'b', label: 'Pencil', category: 'Build' },

        onActivate() { painting = false; painted.clear(); },
        onDeactivate() { if (painting) flush(); painting = false; painted.clear(); },

        onMouseDown(e, tile, ctx) {
          painting = true; painted.clear();
          doPaint(tile.tx, tile.ty);
          return true;
        },
        onMouseMove(e, tile, ctx) {
          if (!painting) return;
          doPaint(tile.tx, tile.ty);
        },
        onMouseUp(e, tile, ctx) {
          if (painting) flush();
          painting = false;
        },
        renderOverlay(ctx2d, cam) {
          if (typeof hoverWX !== 'undefined' && hoverWX >= 0) {
            const sx = (hoverWX - cam.camX) * cam.TILE;
            const sy = (cam.camTopY - hoverWY - 1) * cam.TILE;
            ctx2d.strokeStyle = 'rgba(255,255,255,0.4)';
            ctx2d.lineWidth = 1;
            ctx2d.strokeRect(sx, sy, cam.TILE, cam.TILE);
          }
        },
        renderPanel(container) { renderTexPanel(container); },
      });

      // ── Bucket Tool ──────────────────────────────────────────────────
      engine.registerTool({
        id: 'bucket',
        name: 'Bucket',
        icon: 'B',
        category: 'terrain',
        cursor: 'cell',
        keybind: { action: 'tool.bucket', key: 'g', label: 'Bucket Fill', category: 'Build' },

        onMouseDown(e, tile, ctx) {
          engine.send({
            t: 'bucket', x: tile.tx, y: tile.ty,
            tile: paintTile,
            color: paintTile === T.CUSTOM ? customBrushColor : null,
            variant: paintVariant,
          });
          return true;
        },
        renderPanel(container) { renderTexPanel(container); },
      });

      // ── Eyedropper Tool ──────────────────────────────────────────────
      engine.registerTool({
        id: 'eyedropper',
        name: 'Eyedropper',
        icon: 'I',
        category: 'terrain',
        cursor: 'copy',
        keybind: { action: 'tool.eyedropper', key: 'i', label: 'Eyedropper', category: 'Build' },

        onMouseDown(e, tile, ctx) {
          paintTile = engine.tileAt(tile.tx, tile.ty);
          paintVariant = engine.getVariant(tile.tx, tile.ty);
          engine.setActiveTool('pencil');
          engine.showChat('Picked tile', '#333');
          return true;
        },
      });

      // ── Paint helpers ────────────────────────────────────────────────
      const strokeBuf = [];

      function doPaint(tx, ty) {
        const k = `${tx}_${ty}`;
        if (painted.has(k)) return;
        painted.add(k);
        const color = paintTile === T.CUSTOM ? customBrushColor : null;
        // Update local immediately for instant feedback
        engine.setLocalTile(tx, ty, paintTile);
        engine.setVariant(tx, ty, paintVariant);
        if (color) engine.setLocalColor(tx, ty, color);
        else engine.setLocalColor(tx, ty, null);
        strokeBuf.push({ x: tx, y: ty, tile: paintTile, color, variant: paintVariant });
      }

      function flush() {
        if (strokeBuf.length === 0) return;
        engine.send({ t: 'paint', tiles: strokeBuf.slice() });
        strokeBuf.length = 0;
      }

      // ── Texture Panel (shared by pencil + bucket) ────────────────────
      function renderTexPanel(container) {
        const textures = engine.allTextures;
        const T = engine.T;
        const objectTypes = new Set([T.TREE, T.BUSH, T.FLOWER, T.FISH_SPOT, T.DOOR, T.CUSTOM]);
        const base = textures.filter(t => !objectTypes.has(t.type));
        const categories = ['All', ...new Set(base.map(t => t.category))];

        let html = '<div style="margin-bottom:6px;">';
        // Tool buttons
        html += '<div style="display:flex;gap:3px;margin-bottom:6px;flex-wrap:wrap;">';
        const tools = [['pencil','Pencil'],['bucket','Bucket'],['eyedropper','Eyedropper']];
        for (const [id, label] of tools) {
          const active = engine.getActiveTool() && engine.getActiveTool().id === id;
          html += `<button class="bp-btn${active?' active':''}" onclick="engine.setActiveTool('${id}')">${label}</button>`;
        }
        html += '</div>';
        // Current swatch + tint
        html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">';
        html += '<div id="tp-swatch" style="width:24px;height:24px;border:1px solid #666;border-radius:2px;"></div>';
        html += '<input type="color" id="tp-tint" value="#ffffff" style="width:24px;height:24px;border:1px solid #444;cursor:pointer;padding:0;" title="Tint">';
        html += '<span style="color:#666;font-size:9px;margin-left:auto;">v' + paintVariant + '</span>';
        html += '</div>';
        // Category filter
        html += '<div style="display:flex;gap:1px;flex-wrap:wrap;margin-bottom:4px;">';
        for (const cat of categories) {
          html += `<button class="bp-btn" onclick="this.parentElement.dataset.cat='${cat}';document.getElementById('tp-grid').innerHTML='';window.__tpRenderGrid('${cat}')" style="font-size:8px;padding:1px 4px;">${cat}</button>`;
        }
        html += '</div>';
        html += '<div id="tp-grid" style="display:flex;gap:2px;flex-wrap:wrap;max-height:160px;overflow-y:auto;"></div>';
        html += '</div>';

        container.innerHTML = html;

        // Swatch
        const swatch = document.getElementById('tp-swatch');
        if (swatch) {
          const key = `${paintTile}_${paintVariant}`;
          const tc = engine.tileTexCanvases[key] || engine.tileTexCanvases[paintTile];
          if (tc) { swatch.style.background = `url(${tc.toDataURL()})`; swatch.style.backgroundSize = 'cover'; swatch.style.imageRendering = 'pixelated'; }
          else swatch.style.background = '#444';
        }

        // Grid render function (called by category buttons)
        window.__tpRenderGrid = function(cat) {
          const grid = document.getElementById('tp-grid');
          if (!grid) return;
          grid.innerHTML = '';
          const filtered = cat === 'All' ? base : base.filter(t => t.category === cat);
          for (const tex of filtered) {
            const thumb = document.createElement('canvas');
            thumb.width = 24; thumb.height = 24;
            thumb.title = (tex.name || engine.TILE_NAMES[tex.type] || '') + ' v' + tex.variant;
            thumb.style.cssText = 'border:1px solid #444;cursor:pointer;border-radius:1px;image-rendering:pixelated;' +
              (paintTile === tex.type && paintVariant === tex.variant ? 'border-color:#3a7;box-shadow:0 0 4px #3a7;' : '');
            const tctx = thumb.getContext('2d');
            tctx.imageSmoothingEnabled = false;
            tctx.drawImage(tex.canvas, 0, 0, 24, 24);
            thumb.addEventListener('click', () => {
              paintTile = tex.type; paintVariant = tex.variant;
              if (!engine.getActiveTool() || !['pencil','bucket','eyedropper'].includes(engine.getActiveTool().id)) {
                engine.setActiveTool('pencil');
              }
              // Re-render panel
              const at = engine.getActiveTool();
              if (at && at.renderPanel) at.renderPanel(container);
            });
            grid.appendChild(thumb);
          }
        };
        window.__tpRenderGrid('All');
      }

      // ── Register build tab ───────────────────────────────────────────
      engine.registerBuildTab({
        id: 'terrain',
        label: 'Terrain',
        icon: '\u25A6',
        render(container) {
          renderTexPanel(container);
        },
      });

      // Expose API for other plugins
      exports.client.api = {
        getPaintTile() { return paintTile; },
        getPaintVariant() { return paintVariant; },
        getCustomColor() { return customBrushColor; },
        setPaintTile(t) { paintTile = t; },
        setPaintVariant(v) { paintVariant = v; },
        setCustomColor(c) { customBrushColor = c; },
      };

      console.log('[terrain-painter] Client ready — 3 tools registered');
    },
  };
})(typeof module !== 'undefined' ? module.exports : (window.__plugins = window.__plugins || {}, window.__plugins['terrain-painter'] = {}));
