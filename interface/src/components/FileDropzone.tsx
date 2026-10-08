"use client";

import { FileUpload } from "@ark-ui/react/file-upload";
import { FileJson, X } from "lucide-react";

/** Single-file drag & drop field (Ark UI FileUpload) with a dashed border. */
export default function FileDropzone({
  label,
  accept,
  onFile,
}: {
  label: string;
  /** MIME type -> extensions map, e.g. {"application/json": [".json"]} */
  accept: Record<string, string[]>;
  onFile: (file: File | null) => void;
}) {
  return (
    <FileUpload.Root
      maxFiles={1}
      accept={accept}
      onFileChange={(d) => onFile(d.acceptedFiles[0] ?? null)}
    >
      <FileUpload.Label className="field-label">{label}</FileUpload.Label>
      <FileUpload.Dropzone className="dropzone">
        <FileJson size={34} strokeWidth={2.2} />
        <span className="display" style={{ fontSize: "1.1rem" }}>
          Drag &amp; drop your file here
        </span>
        <span style={{ fontSize: "0.85rem", color: "var(--foreground-muted)" }}>
          or click to browse
        </span>
      </FileUpload.Dropzone>
      <FileUpload.ItemGroup style={{ marginTop: "0.75rem" }}>
        <FileUpload.Context>
          {({ acceptedFiles }) =>
            acceptedFiles.map((file) => (
              <FileUpload.Item key={file.name} file={file} className="dropzone-file">
                <FileJson size={18} strokeWidth={2.4} />
                <FileUpload.ItemName style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} />
                <FileUpload.ItemSizeText style={{ fontSize: "0.8rem", color: "var(--foreground-muted)" }} />
                <FileUpload.ItemDeleteTrigger className="dropzone-remove" aria-label="Remove file">
                  <X size={16} strokeWidth={3} />
                </FileUpload.ItemDeleteTrigger>
              </FileUpload.Item>
            ))
          }
        </FileUpload.Context>
      </FileUpload.ItemGroup>
      <FileUpload.HiddenInput />
    </FileUpload.Root>
  );
}
