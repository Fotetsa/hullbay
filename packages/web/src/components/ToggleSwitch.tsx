import { clx } from "@medusajs/ui";

type ToggleSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
};

export function ToggleSwitch({
  checked,
  onCheckedChange,
  disabled,
  ...rest
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={clx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-border-interactive",
        checked ? "bg-ui-bg-interactive" : "bg-ui-bg-base-pressed",
        disabled && "cursor-not-allowed opacity-50",
      )}
      {...rest}
    >
      <span
        className={clx(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
