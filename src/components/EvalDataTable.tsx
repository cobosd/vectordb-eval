import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fmtMs,
  SERVICE_COLOR,
  SERVICE_LABEL,
  SERVICES,
  type EvalRow,
} from "@/lib/eval-helpers";

function SortHeader({
  label,
  column,
  className,
}: {
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  column: any;
  className?: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`-ml-2 h-7 px-2 ${className ?? ""}`}
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {label}
      {sorted === "asc" ? (
        <ArrowUp className="ml-1 h-3.5 w-3.5" />
      ) : sorted === "desc" ? (
        <ArrowDown className="ml-1 h-3.5 w-3.5" />
      ) : (
        <ChevronsUpDown className="ml-1 h-3.5 w-3.5 opacity-40" />
      )}
    </Button>
  );
}

const numCell = (v: number) => (
  <span className="font-mono tabular-nums">{fmtMs(v)}</span>
);

const columns: ColumnDef<EvalRow>[] = [
  {
    accessorKey: "mode",
    header: ({ column }) => <SortHeader label="Mode" column={column} />,
    cell: ({ row }) => (
      <Badge variant="outline" className="capitalize">
        {row.original.mode}
      </Badge>
    ),
  },
  {
    accessorKey: "topK",
    header: ({ column }) => <SortHeader label="topK" column={column} />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.topK}</span>,
  },
  {
    accessorKey: "iters",
    header: ({ column }) => <SortHeader label="iters" column={column} />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.iters}</span>,
  },
  {
    accessorKey: "service",
    header: ({ column }) => <SortHeader label="Service" column={column} />,
    cell: ({ row }) => {
      const s = row.original.service;
      return (
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ backgroundColor: SERVICE_COLOR[s] }}
          />
          <span className="font-medium">{SERVICE_LABEL[s]}</span>
        </div>
      );
    },
  },
  {
    accessorKey: "consistency",
    header: ({ column }) => <SortHeader label="Consistency" column={column} />,
    filterFn: (row, id, value) => {
      const c = row.original.consistency ?? "—";
      return c === value;
    },
    cell: ({ row }) => {
      const c = row.original.consistency;
      if (!c) return <span className="text-muted-foreground">—</span>;
      return (
        <Badge variant={c === "strong" ? "default" : "secondary"}>{c}</Badge>
      );
    },
  },
  {
    accessorKey: "avg",
    header: ({ column }) => (
      <SortHeader label="avg" column={column} className="ml-auto" />
    ),
    cell: ({ row }) => numCell(row.original.avg),
    meta: { align: "right" },
  },
  {
    accessorKey: "p50",
    header: ({ column }) => (
      <SortHeader label="p50" column={column} className="ml-auto" />
    ),
    cell: ({ row }) => numCell(row.original.p50),
    meta: { align: "right" },
  },
  {
    accessorKey: "p95",
    header: ({ column }) => (
      <SortHeader label="p95" column={column} className="ml-auto" />
    ),
    cell: ({ row }) => numCell(row.original.p95),
    meta: { align: "right" },
  },
  {
    accessorKey: "max",
    header: ({ column }) => (
      <SortHeader label="max" column={column} className="ml-auto" />
    ),
    cell: ({ row }) => numCell(row.original.max),
    meta: { align: "right" },
  },
];

const ALL = "__all__";

export function EvalDataTable({ rows }: { rows: EvalRow[] }) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const getFilter = (id: string) =>
    (table.getColumn(id)?.getFilterValue() as string | undefined) ?? ALL;
  const setFilter = (id: string, value: string) =>
    table.getColumn(id)?.setFilterValue(value === ALL ? undefined : value);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Service"
          value={getFilter("service")}
          onChange={(v) => setFilter("service", v)}
          options={SERVICES.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))}
        />
        <FilterSelect
          label="Mode"
          value={getFilter("mode")}
          onChange={(v) => setFilter("mode", v)}
          options={[
            { value: "unfiltered", label: "Unfiltered" },
            { value: "filtered", label: "Filtered" },
          ]}
        />
        <FilterSelect
          label="Consistency"
          value={getFilter("consistency")}
          onChange={(v) => setFilter("consistency", v)}
          options={[
            { value: "eventual", label: "Eventual" },
            { value: "strong", label: "Strong" },
            { value: "—", label: "n/a (—)" },
          ]}
        />
        <div className="ml-auto text-sm text-muted-foreground">
          {table.getFilteredRowModel().rows.length} of {rows.length} rows
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => {
                  const align =
                    (header.column.columnDef.meta as { align?: string })
                      ?.align === "right";
                  return (
                    <TableHead
                      key={header.id}
                      className={align ? "text-right" : ""}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    const align =
                      (cell.column.columnDef.meta as { align?: string })
                        ?.align === "right";
                    return (
                      <TableCell
                        key={cell.id}
                        className={align ? "text-right" : ""}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[150px]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}s</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
