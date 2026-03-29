"use client";

import { useState, useMemo, useCallback } from "react";
import { Code, Eye, Download, Copy, Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import Papa from "papaparse";

interface CsvRendererProps {
  content: string;
  title?: string;
}

type SortDir = "asc" | "desc" | null;

export function CsvRenderer({ content, title }: CsvRendererProps) {
  const [showSource, setShowSource] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [copied, setCopied] = useState(false);

  // Parse CSV content
  const { headers, rows } = useMemo(() => {
    const result = Papa.parse<string[]>(content, {
      skipEmptyLines: true,
    });

    const data = result.data;
    if (data.length === 0) return { headers: [] as string[], rows: [] as string[][] };

    return {
      headers: data[0],
      rows: data.slice(1),
    };
  }, [content]);

  // Filter rows by search query
  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((row) =>
      row.some((cell) => cell.toLowerCase().includes(q)),
    );
  }, [rows, searchQuery]);

  // Sort filtered rows
  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return filteredRows;

    const col = sortCol;
    return [...filteredRows].sort((a, b) => {
      const va = a[col] ?? "";
      const vb = b[col] ?? "";

      // Try numeric sort
      const na = Number(va);
      const nb = Number(vb);
      if (!isNaN(na) && !isNaN(nb) && va !== "" && vb !== "") {
        return sortDir === "asc" ? na - nb : nb - na;
      }

      // Fallback to string sort
      const cmp = va.localeCompare(vb, undefined, { sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredRows, sortCol, sortDir]);

  const handleSort = useCallback(
    (colIndex: number) => {
      if (sortCol !== colIndex) {
        setSortCol(colIndex);
        setSortDir("asc");
      } else if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortCol(null);
        setSortDir(null);
      }
    },
    [sortCol, sortDir],
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = title?.replace(/[/\\]/g, "_") || "data.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [content, title]);

  const isFiltered = searchQuery.trim().length > 0;
  const totalRows = rows.length;
  const shownRows = sortedRows.length;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--surface-tertiary)] shrink-0">
        <span className="text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide shrink-0">
          {showSource ? "Source" : "Table"}
        </span>

        {/* Search — only in table view */}
        {!showSource && (
          <div className="flex items-center gap-1.5 flex-1 max-w-[240px] ml-2 px-2 py-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] focus-within:border-[var(--border-heavy)] transition-colors">
            <Search className="h-3 w-3 text-[var(--text-tertiary)] shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="flex-1 text-xs bg-transparent outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
          </div>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCopy}
            title="Copy CSV"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleDownload}
            title="Download"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowSource(!showSource)}
            title={showSource ? "Show table" : "Show source"}
          >
            {showSource ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Content */}
      {showSource ? (
        <pre className="flex-1 overflow-auto p-4 text-[13px] leading-relaxed font-mono text-[var(--text-primary)] bg-[var(--surface-secondary)]">
          {content}
        </pre>
      ) : (
        <div className="flex-1 overflow-auto bg-[var(--surface-primary)]">
          {headers.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-tertiary)]">
              No data to display
            </div>
          ) : (
            <table className="csv-table">
              <thead>
                <tr>
                  {headers.map((header, i) => (
                    <th
                      key={i}
                      onClick={() => handleSort(i)}
                      className="cursor-pointer select-none hover:bg-[#eee]"
                    >
                      <span className="inline-flex items-center gap-1">
                        {header}
                        {sortCol === i && (
                          <span className="text-[10px] leading-none">
                            {sortDir === "asc" ? "\u25B2" : "\u25BC"}
                          </span>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, ri) => (
                  <tr key={ri}>
                    {headers.map((_, ci) => (
                      <td key={ci}>{row[ci] ?? ""}</td>
                    ))}
                  </tr>
                ))}
                {sortedRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={headers.length}
                      className="text-center text-[var(--text-tertiary)] py-8"
                    >
                      No matching rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Status bar */}
      {!showSource && headers.length > 0 && (
        <div className="flex items-center px-3 py-1.5 border-t border-[var(--border-default)] bg-[var(--surface-tertiary)] text-[11px] text-[var(--text-tertiary)] shrink-0 tabular-nums">
          {isFiltered
            ? `Showing ${shownRows} of ${totalRows} rows \u00d7 ${headers.length} columns`
            : `${totalRows} rows \u00d7 ${headers.length} columns`}
        </div>
      )}
    </div>
  );
}
