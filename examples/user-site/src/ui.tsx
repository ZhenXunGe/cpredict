import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Copy, Check, AlertCircle, ExternalLink } from "lucide-react";
import { formatUnits } from "viem";
import { errorCopy } from "./api.js";
export function Button({
  variant = "primary",
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button button-${variant} ${props.className ?? ""}`}
    />
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small id={id}>{hint}</small>}
    </label>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "success";
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <AlertCircle size={18} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div role="alert">
      <Notice tone="warning">
        {errorCopy(error)}
        {retry && (
          <Button variant="quiet" onClick={retry}>
            重新查询
          </Button>
        )}
      </Notice>
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        CP
      </div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading({ label = "正在读取最新数据" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
export function Amount({
  value,
  asset,
  sign = false,
}: {
  value: string | null | undefined;
  asset?: string;
  sign?: boolean;
}) {
  if (value == null) return <span className="muted">未知</span>;
  const text = formatUnits(BigInt(value), 6);
  return (
    <span className="amount">
      {sign && BigInt(value) > 0n ? "+" : ""}
      {text}
      {asset && <span className="amount-unit"> {asset}</span>}
    </span>
  );
}
export const shortAddress = (value: string) =>
  `${value.slice(0, 6)}…${value.slice(-4)}`;
export function AddressText({
  value,
  explorer,
  full = false,
}: {
  value: string;
  explorer?: string;
  full?: boolean;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  return (
    <span className="address-group">
      <code title={value}>{full ? value : shortAddress(value)}</code>
      <button
        className="icon-button"
        type="button"
        aria-label="复制地址"
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              setError(false);
              setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => setError(true));
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {explorer && (
        <a
          className="icon-button"
          href={`${explorer}/address/${value}`}
          target="_blank"
          rel="noreferrer"
          aria-label="在区块浏览器查看地址"
        >
          <ExternalLink size={15} />
        </a>
      )}
      {error && <span role="status">复制失败，请选择地址手动复制</span>}
    </span>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog"
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = opener.current?.isConnected
              ? opener.current
              : document.getElementById("main-content");
            target?.focus({ preventScroll: true });
          }}
        >
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-button" aria-label="关闭">
                <X />
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
