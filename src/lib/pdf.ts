/**
 * Close-package PDF (part of surface 3: emailed digest + PDF). Programmatic via
 * pdfkit — no browser, no LaTeX. One clean page: verdict, portfolio P&L, business
 * deductions, cash, estimated tax, what needs review, and the standing disclaimer.
 */
import PDFDocument from "pdfkit";
import type { DashboardData } from "./dashboard-data.js";
import { formatUsd } from "../core/money.js";

const INK = "#1a1a1a";
const MUT = "#666666";
const LINE = "#dddddd";

export function buildClosePdf(data: DashboardData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const v = data.closePackage;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    doc.fillColor(INK).fontSize(20).font("Helvetica-Bold").text(`Month-End Close — ${data.period}`);
    doc.moveDown(0.2);
    doc.fontSize(10).font("Helvetica").fillColor(MUT)
      .text(`${data.closeStatus ?? "DRAFT"}${data.locked ? " · LOCKED" : ""} · tie-out ${v.tieOut ? "OK" : "MISMATCH"} · generated ${new Date(data.generatedAt).toLocaleString()}`);
    doc.moveDown(0.8);

    const section = (title: string) => {
      doc.moveDown(0.5).fillColor(INK).fontSize(12).font("Helvetica-Bold").text(title);
      doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor(LINE).stroke();
      doc.moveDown(0.4).font("Helvetica").fontSize(10);
    };
    const line = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.fillColor(INK).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      doc.text(label, left, y, { width: 340 });
      doc.text(value, left, y, { width: right - left, align: "right" });
      doc.moveDown(0.1);
    };

    section("Portfolio P&L");
    line("Revenue", formatUsd(v.portfolio.revenueCents));
    line("COGS", formatUsd(-v.portfolio.cogsCents));
    line("Operating expense", formatUsd(-v.portfolio.expenseCents));
    line("Net income", formatUsd(v.portfolio.netCents), true);
    line("Estimated quarterly tax set-aside", formatUsd(v.estimatedTaxCents));
    line("Cash on hand", formatUsd(v.cash.totalCents));

    section("Per-project P&L");
    if (v.perProject.length === 0) doc.fillColor(MUT).text("none");
    for (const p of v.perProject) line(p.projectSlug, formatUsd(p.netCents));

    section("Schedule-C rollup (YTD)");
    if (v.scheduleC.length === 0) doc.fillColor(MUT).text("none yet");
    for (const s of v.scheduleC) line(`Line ${s.scheduleLine} · ${s.accountName}`, formatUsd(s.amountCents));

    section("Needs your review");
    doc.fillColor(INK).text(`${data.quarantine.length} transaction(s) await a business/personal decision.`);
    for (const q of data.quarantine.slice(0, 12)) {
      line(`${q.date ?? ""}  ${q.merchant}`.slice(0, 60), formatUsd(q.amountCents));
    }
    if (data.quarantine.length > 12) doc.fillColor(MUT).fontSize(9).text(`…and ${data.quarantine.length - 12} more (see the spreadsheet / dashboard).`);

    doc.moveDown(1).fontSize(8).fillColor(MUT).font("Helvetica-Oblique")
      .text("Bookkeeping output for your records and your tax preparer. Not licensed tax advice. Aggressive but legal positions are flagged for CPA review. Review with a licensed CPA/EA before filing.", { width: right - left });

    doc.end();
  });
}
