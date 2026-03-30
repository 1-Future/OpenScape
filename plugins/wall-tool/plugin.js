(function(exports) {
  exports.meta = {
    id: 'wall-tool',
    name: 'Wall Tool',
    version: '1.0.0',
    depends: [],
  };

  const WALL_N = 1, WALL_E = 2, WALL_S = 4, WALL_W = 8;
  const WALL_DIAG_NE = 16, WALL_DIAG_NW = 32;

  exports.server = {
    api: { WALL_N, WALL_E, WALL_S, WALL_W, WALL_DIAG_NE, WALL_DIAG_NW },
    init(engine) { console.log('[wall-tool] Server ready'); },
  };

  exports.client = {
    api: { WALL_N, WALL_E, WALL_S, WALL_W, WALL_DIAG_NE, WALL_DIAG_NW },
    init(engine) {
      let dragStart = null;
      let dragging = false;
      let preview = [];

      function getNearestVertex(e, cam) {
        const rect = e.target.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = cam.camX + mx / cam.TILE;
        const wy = cam.camTopY - my / cam.TILE;
        return { vx: Math.round(wx), vy: Math.round(wy) };
      }

      function calcWallLine(vx1, vy1, vx2, vy2) {
        const edges = [];
        const dx = vx2 - vx1, dy = vy2 - vy1;
        const adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx === 0 && ady === 0) return edges;
        if (adx >= ady) {
          const startX = Math.min(vx1, vx2), endX = Math.max(vx1, vx2);
          const y = vy1;
          for (let vx = startX; vx < endX; vx++) edges.push({ x: vx, y, side: WALL_S });
        } else {
          const startY = Math.min(vy1, vy2), endY = Math.max(vy1, vy2);
          const x = vx1;
          for (let vy = startY; vy < endY; vy++) edges.push({ x, y: vy, side: WALL_W });
        }
        return edges;
      }

      function calcRoomWalls(vx1, vy1, vx2, vy2) {
        const edges = [];
        const minX = Math.min(vx1, vx2), maxX = Math.max(vx1, vx2);
        const minY = Math.min(vy1, vy2), maxY = Math.max(vy1, vy2);
        if (minX === maxX || minY === maxY) return calcWallLine(vx1, vy1, vx2, vy2);
        for (let x = minX; x < maxX; x++) edges.push({ x, y: maxY - 1, side: WALL_N });
        for (let x = minX; x < maxX; x++) edges.push({ x, y: minY, side: WALL_S });
        for (let y = minY; y < maxY; y++) edges.push({ x: minX, y, side: WALL_W });
        for (let y = minY; y < maxY; y++) edges.push({ x: maxX - 1, y, side: WALL_E });
        return edges;
      }

      function placeEdges(edges, deleting) {
        for (const edge of edges) {
          const cur = engine.getWallEdge(edge.x, edge.y);
          const mask = deleting ? (cur & ~edge.side) : (cur | edge.side);
          engine.send({ t: 'wall_edge', x: edge.x, y: edge.y, mask });
        }
      }

      function renderEdgePreview(ctx2d, cam, edges, color) {
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = Math.max(2, Math.floor(cam.TILE / 5));
        ctx2d.beginPath();
        for (const edge of edges) {
          const sx = (edge.x - cam.camX) * cam.TILE;
          const sy = (cam.camTopY - edge.y - 1) * cam.TILE;
          if (edge.side === WALL_N) { ctx2d.moveTo(sx, sy); ctx2d.lineTo(sx + cam.TILE, sy); }
          else if (edge.side === WALL_S) { ctx2d.moveTo(sx, sy + cam.TILE); ctx2d.lineTo(sx + cam.TILE, sy + cam.TILE); }
          else if (edge.side === WALL_W) { ctx2d.moveTo(sx, sy); ctx2d.lineTo(sx, sy + cam.TILE); }
          else if (edge.side === WALL_E) { ctx2d.moveTo(sx + cam.TILE, sy); ctx2d.lineTo(sx + cam.TILE, sy + cam.TILE); }
        }
        ctx2d.stroke();
      }

      // ── Wall Tool (straight line) ────────────────────────────────────
      engine.registerTool({
        id: 'wall-tool',
        name: 'Wall',
        icon: 'W',
        category: 'walls',
        cursor: 'crosshair',
        keybind: { action: 'tool.wall', key: 'w', label: 'Wall', category: 'Build' },

        onActivate() { dragStart = null; dragging = false; preview = []; },
        onDeactivate() { dragStart = null; dragging = false; preview = []; },

        onMouseDown(e, tile, ctx) {
          const v = getNearestVertex(e, ctx.camera);
          dragStart = { vx: v.vx, vy: v.vy, deleting: false };
          dragging = true; preview = [];
          return true;
        },
        onRightClick(e, tile, ctx) {
          const v = getNearestVertex(e, ctx.camera);
          dragStart = { vx: v.vx, vy: v.vy, deleting: true };
          dragging = true; preview = [];
          return true;
        },
        onMouseMove(e, tile, ctx) {
          if (!dragging || !dragStart) return;
          const v = getNearestVertex(e, ctx.camera);
          preview = calcWallLine(dragStart.vx, dragStart.vy, v.vx, v.vy);
        },
        onMouseUp(e, tile, ctx) {
          if (!dragging || !dragStart) return;
          const v = getNearestVertex(e, ctx.camera);
          const edges = calcWallLine(dragStart.vx, dragStart.vy, v.vx, v.vy);
          placeEdges(edges, dragStart.deleting);
          dragging = false; dragStart = null; preview = [];
        },
        renderOverlay(ctx2d, cam) {
          if (preview.length > 0) {
            renderEdgePreview(ctx2d, cam, preview, dragStart && dragStart.deleting ? 'rgba(255,60,60,0.85)' : 'rgba(0,220,255,0.85)');
          }
        },
        renderPanel(container) { renderWallPanel(container); },
      });

      // ── Room Tool (rectangular) ──────────────────────────────────────
      engine.registerTool({
        id: 'room-tool',
        name: 'Room',
        icon: 'R',
        category: 'walls',
        cursor: 'crosshair',

        onActivate() { dragStart = null; dragging = false; preview = []; },
        onDeactivate() { dragStart = null; dragging = false; preview = []; },

        onMouseDown(e, tile, ctx) {
          const v = getNearestVertex(e, ctx.camera);
          dragStart = { vx: v.vx, vy: v.vy, deleting: false };
          dragging = true; preview = [];
          return true;
        },
        onRightClick(e, tile, ctx) {
          const v = getNearestVertex(e, ctx.camera);
          dragStart = { vx: v.vx, vy: v.vy, deleting: true };
          dragging = true; preview = [];
          return true;
        },
        onMouseMove(e, tile, ctx) {
          if (!dragging || !dragStart) return;
          const v = getNearestVertex(e, ctx.camera);
          preview = calcRoomWalls(dragStart.vx, dragStart.vy, v.vx, v.vy);
        },
        onMouseUp(e, tile, ctx) {
          if (!dragging || !dragStart) return;
          const v = getNearestVertex(e, ctx.camera);
          const edges = calcRoomWalls(dragStart.vx, dragStart.vy, v.vx, v.vy);
          placeEdges(edges, dragStart.deleting);
          dragging = false; dragStart = null; preview = [];
        },
        renderOverlay(ctx2d, cam) {
          if (preview.length > 0) {
            renderEdgePreview(ctx2d, cam, preview, dragStart && dragStart.deleting ? 'rgba(255,60,60,0.85)' : 'rgba(0,220,255,0.85)');
          }
        },
        renderPanel(container) { renderWallPanel(container); },
      });

      // ── Door Tool ────────────────────────────────────────────────────
      engine.registerTool({
        id: 'door-tool',
        name: 'Door',
        icon: 'D',
        category: 'walls',
        cursor: 'crosshair',

        onMouseDown(e, tile, ctx) {
          // Detect which edge of the tile was clicked
          const rect = e.target.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const fracX = (mx / ctx.camera.TILE) % 1;
          const fracY = (my / ctx.camera.TILE) % 1;
          const dN = fracY, dS = 1 - fracY, dW = fracX, dE = 1 - fracX;
          const minD = Math.min(dN, dS, dW, dE);
          let side;
          if (minD === dN) side = WALL_N;
          else if (minD === dS) side = WALL_S;
          else if (minD === dW) side = WALL_W;
          else side = WALL_E;

          const cur = engine.getDoorEdge(tile.tx, tile.ty);
          const mask = cur ^ side;
          engine.send({ t: 'door_edge', x: tile.tx, y: tile.ty, mask });
          return true;
        },
        renderPanel(container) { renderWallPanel(container); },
      });

      // ── Shared panel for wall tools ──────────────────────────────────
      function renderWallPanel(container) {
        let html = '<div style="margin-bottom:6px;">';
        html += '<div style="display:flex;gap:3px;margin-bottom:6px;flex-wrap:wrap;">';
        const tools = [['wall-tool','Wall'],['room-tool','Room'],['door-tool','Door']];
        for (const [id, label] of tools) {
          const active = engine.getActiveTool() && engine.getActiveTool().id === id;
          html += `<button class="bp-btn${active?' active':''}" onclick="engine.setActiveTool('${id}')">${label}</button>`;
        }
        html += '</div>';
        html += '<div style="color:#666;font-size:10px;">Drag to draw walls/rooms. Click edges for doors. Right-drag to delete.</div>';
        html += '</div>';
        container.innerHTML = html;
      }

      // ── Register build tab ───────────────────────────────────────────
      engine.registerBuildTab({
        id: 'walls',
        label: 'Walls & Rooms',
        icon: '\u2B1C',
        render(container) { renderWallPanel(container); },
      });

      console.log('[wall-tool] Client ready — 3 tools registered');
    },
  };
})(typeof module !== 'undefined' ? module.exports : (window.__plugins = window.__plugins || {}, window.__plugins['wall-tool'] = {}));
