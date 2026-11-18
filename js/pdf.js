/**
 * pdf.js: builds the match history PDF with jsPDF.
 * It looks the same on every device and has no browser header/footer.
 * The library only loads when Export is pressed. If it fails, the app prints instead.
 */

const PdfExport = (() => {
  const LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  ];

  const PLUM = [111, 82, 127];
  const TEXT = [51, 40, 59];
  const MUTED = [110, 100, 117];
  const LINE = [222, 215, 226];
  const AMBER = [133, 90, 0];

  let loading = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadLibs() {
    if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
    if (!loading) {
      loading = LIBS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
        .catch(err => { loading = null; throw err; });
    }
    return loading;
  }

  /** Load an image and convert it to PNG (jsPDF can't use WebP). */
  function loadImageAsPng(url, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = maxSide ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ data: canvas.toDataURL('image/png'), w, h });
      };
      img.onerror = () => reject(new Error(`Could not load image ${url}`));
      img.src = url;
    });
  }

  function playerColumns(n) {
    return n <= 6 ? 2 : n <= 18 ? 3 : n <= 36 ? 4 : n <= 60 ? 5 : 6;
  }

  /**
   * data = {
   *   sessionName, dateLabel, courts, matchType, players,
   *   history: [{ number, time, court, team1, team2, winner, score, manual }],  // newest first
   *   sponsorUrl, logoUrl, watermarkUrl
   * }
   * options.save (default true): download the file. If false, just return the doc.
   */
  async function generate(data, options = {}) {
    await loadLibs();
    const [watermark, logo] = await Promise.all([
      loadImageAsPng(data.watermarkUrl, 700),
      loadImageAsPng(data.logoUrl),
    ]);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 15;

    // Session name with characters that aren't allowed in file names removed
    const safeName = (data.sessionName || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const docTitle = ['Pickleball Match History', safeName, data.dateLabel].filter(Boolean).join(' - ');
    doc.setProperties({ title: docTitle, subject: 'Pickleball open play results', creator: 'Pickleball Open Play' });

    // ---- faint sponsor badge behind every page (drawn first) ----
    const pagesWithWatermark = new Set();
    function drawWatermark() {
      const page = doc.internal.getCurrentPageInfo().pageNumber;
      if (pagesWithWatermark.has(page)) return;
      pagesWithWatermark.add(page);
      const size = Math.min(W - 2 * M, 170);
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.1 }));
      doc.addImage(watermark.data, 'PNG', (W - size) / 2, (H - size) / 2, size, size, 'watermark', 'FAST');
      doc.restoreGraphicsState();
    }
    drawWatermark();

    // ---- title + sponsor ----
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(...TEXT);
    doc.text('Pickleball Match History', M, M + 7);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    const courtsLabel = `${data.courts} court${data.courts === 1 ? '' : 's'}`;
    const subtitle = [data.sessionName, data.dateLabel, courtsLabel, data.matchType].filter(Boolean);
    doc.text(subtitle.join('  ·  '), M, M + 13);

    const logoH = 15;
    const logoW = logoH * (logo.w / logo.h);
    const logoX = W - M - logoW;
    const logoY = M - 2;
    doc.addImage(logo.data, 'PNG', logoX, logoY, logoW, logoH, 'sponsor', 'FAST');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text('SPONSORED BY', logoX - 2.5, logoY + logoH / 2 + 1, { align: 'right' });
    if (data.sponsorUrl) {
      doc.link(logoX - 24, logoY, logoW + 24, logoH, { url: data.sponsorUrl });
    }

    let y = M + 19;
    doc.setDrawColor(...TEXT);
    doc.setLineWidth(0.5);
    doc.line(M, y, W - M, y);
    y += 8;

    // ---- players: numbered, more columns for more players ----
    // players: [{ name, note, left }] or plain names
    const roster = data.players.map(p => (typeof p === 'string' ? { name: p, note: '', left: false } : p));
    const n = roster.length;
    const leftCount = roster.filter(p => p.left).length;
    const cols = playerColumns(n);
    const rows = Math.ceil(n / cols);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...TEXT);
    doc.text(`Players (${n}${leftCount ? ` · ${leftCount} left` : ''})`, M, y);

    const playerBody = Array.from({ length: rows }, (_, r) => {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const i = c * rows + r; // fill each column top to bottom
        const p = roster[i];
        row.push(p ? String(i + 1) : '', p ? (p.note ? `${p.name}  (${p.note})` : p.name) : '');
      }
      return row;
    });
    const colWidth = (W - 2 * M) / cols;
    const playerColumnStyles = {};
    for (let c = 0; c < cols; c++) {
      playerColumnStyles[c * 2] = { cellWidth: 8, halign: 'right', fontStyle: 'bold', fontSize: 7.5, textColor: PLUM };
      playerColumnStyles[c * 2 + 1] = { cellWidth: colWidth - 8 };
    }
    doc.autoTable({
      startY: y + 2.5,
      body: playerBody,
      theme: 'plain',
      margin: { left: M, right: M, top: M },
      styles: {
        font: 'helvetica', fontSize: 9.5, textColor: TEXT, overflow: 'ellipsize',
        cellPadding: { top: 1.4, bottom: 1.4, left: 1.2, right: 2 },
        lineColor: LINE, lineWidth: { bottom: 0.15 },
      },
      columnStyles: playerColumnStyles,
      didParseCell: cell => {
        if (cell.cell.raw === '') { cell.cell.styles.lineWidth = 0; return; }
        const p = roster[Math.floor(cell.column.index / 2) * rows + cell.row.index];
        if (p && p.left && cell.column.index % 2 === 1) {
          cell.cell.styles.textColor = MUTED;
          cell.cell.styles.fontStyle = 'italic';
        }
      },
      willDrawPage: drawWatermark,
    });

    // ---- match history ----
    y = doc.lastAutoTable.finalY + 10;
    if (y > H - M - 25) {
      doc.addPage();
      drawWatermark();
      y = M + 6;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...TEXT);
    doc.text(`Match History (${data.history.length})`, M, y);

    const historyBody = data.history.length
      ? data.history.map(h => [
        String(h.number),
        h.manual ? `${h.time}\nAdjusted` : h.time,
        String(h.court),
        h.team1,
        h.team2,
        h.winner === 'team1' ? h.team1 : h.team2,
        h.score || 'Not recorded',
      ])
      : [[{ content: 'No matches completed yet.', colSpan: 7, styles: { halign: 'center', fontStyle: 'italic', textColor: MUTED } }]];

    doc.autoTable({
      startY: y + 2.5,
      head: [['#', 'Time', 'Court', 'Team 1', 'Team 2', 'Winner', 'Score']],
      body: historyBody,
      theme: 'plain',
      showHead: 'everyPage',
      margin: { left: M, right: M, top: M },
      styles: {
        font: 'helvetica', fontSize: 9, textColor: TEXT, valign: 'middle',
        cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 },
        lineColor: LINE, lineWidth: { bottom: 0.15 },
      },
      headStyles: {
        fontStyle: 'bold', fontSize: 7.5, textColor: MUTED,
        lineColor: TEXT, lineWidth: { bottom: 0.4 },
      },
      columnStyles: {
        0: { cellWidth: 9, fontStyle: 'bold', textColor: PLUM },
        1: { cellWidth: 20, textColor: MUTED },
        2: { cellWidth: 13, halign: 'center' },
        6: { cellWidth: 22, halign: 'right', fontStyle: 'bold' },
      },
      didParseCell: cell => {
        if (cell.section === 'head') {
          if (cell.column.index === 2) cell.cell.styles.halign = 'center';
          if (cell.column.index === 6) cell.cell.styles.halign = 'right';
          return;
        }
        const h = data.history[cell.row.index];
        if (!h) return;
        const col = cell.column.index;
        if (col === 3 || col === 4) {
          const won = (col === 3) === (h.winner === 'team1');
          cell.cell.styles.fontStyle = won ? 'bold' : 'normal';
          cell.cell.styles.textColor = won ? TEXT : MUTED;
        } else if (col === 5) {
          cell.cell.styles.fontStyle = 'bold';
          cell.cell.styles.textColor = PLUM;
        } else if (col === 6 && !h.score) {
          cell.cell.styles.fontStyle = 'normal';
          cell.cell.styles.fontSize = 7.5;
          cell.cell.styles.textColor = MUTED;
        } else if (col === 1 && h.manual) {
          cell.cell.styles.textColor = AMBER;
        }
      },
      willDrawPage: drawWatermark,
    });

    if (options.save !== false) {
      const fileName = `${docTitle}.pdf`;
      try {
        doc.save(fileName);
      } catch (err) {
        // Some in-app browsers block downloads, so show the PDF instead
        window.open(doc.output('bloburl'), '_blank');
      }
    }
    return doc;
  }

  return { generate, loadLibs, playerColumns };
})();
