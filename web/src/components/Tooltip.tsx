import { isValidElement, type ReactElement, type ReactNode, type HTMLAttributes } from "react";
import { Tooltip as RadixTooltip } from "radix-ui";

export interface TooltipProps extends Omit<HTMLAttributes<HTMLDivElement>, "content"> {
  content: ReactNode;
  shortcut?: string;
  position?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

export function Tooltip({ content, shortcut, position = "bottom", children, className = "", ...props }: TooltipProps) {
  const child = isValidElement(children) ? children as ReactElement<{ disabled?: boolean }> : null;
  const disabled = Boolean(child?.props.disabled);
  return <RadixTooltip.Provider delayDuration={120}>
    <RadixTooltip.Root>
      {disabled || !child ? (
        <RadixTooltip.Trigger asChild><div className={`tooltip-trigger ${className}`} {...props}>{children}</div></RadixTooltip.Trigger>
      ) : (
        <div className={`tooltip-trigger ${className}`} {...props}><RadixTooltip.Trigger asChild>{child}</RadixTooltip.Trigger></div>
      )}
      <RadixTooltip.Portal><RadixTooltip.Content className="tooltip-bubble" side={position} sideOffset={8} collisionPadding={8}>
        <span className="tooltip-text">{content}</span>{shortcut && <kbd className="tooltip-kbd">{shortcut}</kbd>}
      </RadixTooltip.Content></RadixTooltip.Portal>
    </RadixTooltip.Root>
  </RadixTooltip.Provider>;
}
