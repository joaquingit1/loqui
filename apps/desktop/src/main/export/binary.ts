/**
 * Binary export transforms (PRD-13): PDF (pdfkit) + DOCX (docx).
 *
 * Like the text transforms (./transforms.ts) these are PURE over the normalized
 * {@link ExportModel} — they read only the model and produce bytes; they never
 * touch the canonical transcript. They are async (the libs stream/await) and
 * resolve to a Buffer the service writes to the export dir.
 *
 * The libs are pure-JS + bundle-friendly (PRD-8 packages them): `pdfkit` emits a
 * valid `%PDF-1.x` document; `docx` emits a valid OOXML (.docx) zip whose first
 * bytes are the `PK` zip magic.
 */
import PDFDocument from "pdfkit";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { ExportModel } from "./model.js";
import { formatVttTimestamp } from "./transforms.js";

/** `hh:mm:ss` (drops the VTT milliseconds) for human-facing document bodies. */
function clock(seconds: number): string {
  return formatVttTimestamp(seconds).split(".")[0]!;
}

// --- PDF -----------------------------------------------------------------------

/**
 * Render the model as a PDF (binary). Title, an optional summary section, then
 * the transcript as `[hh:mm:ss] Speaker: text` lines. Resolves to the full PDF
 * bytes (starts with the `%PDF-` magic). Deterministic given the model.
 */
export function toPdf(model: ExportModel): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: model.meeting.title } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      doc.fontSize(20).text(model.meeting.title || "Untitled meeting");
      doc.moveDown(0.5);
      doc
        .fontSize(10)
        .fillColor("#555555")
        .text(`Kind: ${model.meeting.kind}   Speakers: ${model.speakers.join(", ") || "—"}`);
      doc.fillColor("#000000");
      doc.moveDown();

      const s = model.summary;
      if (s) {
        doc.fontSize(14).text("Summary");
        doc.moveDown(0.3);
        if (s.tldr.trim() !== "") doc.fontSize(11).text(s.tldr.trim());
        if (s.decisions.length > 0) {
          doc.moveDown(0.3).fontSize(12).text("Decisions");
          doc.fontSize(11).list(s.decisions);
        }
        if (s.actionItems.length > 0) {
          doc.moveDown(0.3).fontSize(12).text("Action items");
          doc.fontSize(11).list(
            s.actionItems.map((a) => (a.owner ? `${a.text} (@${a.owner})` : a.text)),
          );
        }
        if (s.topics.length > 0) {
          doc.moveDown(0.3).fontSize(12).text("Topics");
          doc.fontSize(11).list(s.topics);
        }
        doc.moveDown();
      }

      doc.fontSize(14).text("Transcript");
      doc.moveDown(0.3).fontSize(11);
      for (const seg of model.segments) {
        doc.text(`[${clock(seg.tStart)}] ${seg.speaker}: ${seg.text}`);
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// --- DOCX ----------------------------------------------------------------------

/**
 * Render the model as a DOCX (OOXML, binary). Title heading, an optional summary
 * section, and the transcript as `Speaker [hh:mm:ss]: text` paragraphs. Resolves
 * to the .docx zip bytes (first bytes are the `PK` zip magic).
 */
export async function toDocx(model: ExportModel): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: model.meeting.title || "Untitled meeting",
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text: `Kind: ${model.meeting.kind}   Speakers: ${model.speakers.join(", ") || "—"}`,
          italics: true,
          color: "555555",
        }),
      ],
    }),
  ];

  const s = model.summary;
  if (s) {
    children.push(new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_1 }));
    if (s.tldr.trim() !== "") children.push(new Paragraph({ text: s.tldr.trim() }));
    if (s.decisions.length > 0) {
      children.push(new Paragraph({ text: "Decisions", heading: HeadingLevel.HEADING_2 }));
      for (const d of s.decisions) children.push(new Paragraph({ text: d, bullet: { level: 0 } }));
    }
    if (s.actionItems.length > 0) {
      children.push(new Paragraph({ text: "Action items", heading: HeadingLevel.HEADING_2 }));
      for (const a of s.actionItems) {
        const text = a.owner ? `${a.text} (@${a.owner})` : a.text;
        children.push(new Paragraph({ text, bullet: { level: 0 } }));
      }
    }
    if (s.topics.length > 0) {
      children.push(new Paragraph({ text: "Topics", heading: HeadingLevel.HEADING_2 }));
      for (const t of s.topics) children.push(new Paragraph({ text: t, bullet: { level: 0 } }));
    }
  }

  children.push(new Paragraph({ text: "Transcript", heading: HeadingLevel.HEADING_1 }));
  for (const seg of model.segments) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${seg.speaker} `, bold: true }),
          new TextRun({ text: `[${clock(seg.tStart)}]: `, color: "777777" }),
          new TextRun({ text: seg.text }),
        ],
      }),
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
