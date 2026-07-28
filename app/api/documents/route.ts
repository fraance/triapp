import { NextRequest, NextResponse } from "next/server";
import {
  detectFileType,
  extractText,
  saveDocument,
  listDocuments,
  deleteDocument,
  setDocumentIncluded,
} from "@/lib/documents";

export const maxDuration = 60;

/** List the athlete's uploaded context files. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const docs = await listDocuments(userId);
    return NextResponse.json({
      documents: docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        fileType: d.fileType,
        rowCount: d.rowCount,
        includeInAi: d.includeInAi,
        createdAt: d.createdAt,
        preview: d.content.slice(0, 400),
      })),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to list documents" },
      { status: 500 }
    );
  }
}

/** Upload a spreadsheet or notes file. */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const userId = formData.get("userId");
    const file = formData.get("file");

    if (!userId || typeof userId !== "string") {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "A file is required" }, { status: 400 });
    }

    const fileType = detectFileType(file.name);
    if (!fileType) {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Please upload .xlsx, .xls, .csv, .txt or .md",
        },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File is too large (max 10 MB)" },
        { status: 400 }
      );
    }

    const { text, rowCount } = extractText(buffer, fileType);
    if (!text.trim()) {
      return NextResponse.json(
        { error: "Could not read any content from that file" },
        { status: 400 }
      );
    }

    const doc = await saveDocument(userId, file.name, fileType, text, rowCount);

    return NextResponse.json({
      id: doc.id,
      filename: doc.filename,
      fileType: doc.fileType,
      rowCount: doc.rowCount,
      charactersStored: doc.content.length,
    });
  } catch (error: any) {
    console.error("Document upload error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to upload document" },
      { status: 500 }
    );
  }
}

/** Toggle whether a document is sent to the AI. */
export async function PATCH(req: NextRequest) {
  try {
    const { userId, documentId, includeInAi } = await req.json();
    if (!userId || !documentId) {
      return NextResponse.json(
        { error: "userId and documentId are required" },
        { status: 400 }
      );
    }
    const ok = await setDocumentIncluded(userId, documentId, Boolean(includeInAi));
    if (!ok) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    return NextResponse.json({ updated: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to update document" },
      { status: 500 }
    );
  }
}

/** Delete a document. */
export async function DELETE(req: NextRequest) {
  try {
    const { userId, documentId } = await req.json();
    if (!userId || !documentId) {
      return NextResponse.json(
        { error: "userId and documentId are required" },
        { status: 400 }
      );
    }
    const ok = await deleteDocument(userId, documentId);
    if (!ok) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to delete document" },
      { status: 500 }
    );
  }
}
