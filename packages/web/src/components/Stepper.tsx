import { CheckCircleSolid } from "@medusajs/icons"
import type { ReactNode } from "react"

/**
 * Stepper segmenté 3 états (todo/active/done). Deux rangées alignées au pixel :
 *  - rangée 1 : nœuds  + rails de progression entre eux (remplissage vert) ;
 *  - rangée 2 : labels centrés SOUS chaque nœud (jamais déviés par un label long).
 * Easing custom ease-out ; transitions transform/opacity uniquement (GPU).
 */
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: ReactNode[]
  current: number
  className?: string
}) {
  const last = steps.length - 1
  return (
    <div className={className}>
      {/* Rangée nœuds + rails */}
      <div className="flex items-center">
        {steps.map((label, index) => {
          const state = index < current ? "done" : index === current ? "active" : "todo"
          return (
            <div key={index} className="contents">
              <div
                aria-current={state === "active" ? "step" : undefined}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${
                  state === "done"
                    ? "border-ui-border-strong bg-ui-bg-base-pressed text-ui-fg-success"
                    : state === "active"
                      ? "border-ui-border-interactive bg-ui-bg-base-pressed text-ui-fg-on-color ring-1 ring-ui-border-interactive"
                      : "border-ui-border-strong bg-ui-bg-subtle text-ui-fg-muted"
                }`}
              >
                {state === "done" ? (
                  <CheckCircleSolid className="h-4 w-4" />
                ) : (
                  <span className="text-xs font-medium">{index + 1}</span>
                )}
              </div>
              {index < last && (
                <div className="mx-2 h-0.5 flex-1 overflow-hidden rounded-full bg-ui-border-base">
                  <div
                    className="h-full w-full origin-left rounded-full bg-ui-fg-success transition-transform duration-300 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)]"
                    style={{ transform: index < current ? "scaleX(1)" : "scaleX(0)" }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
      {/* Rangée labels — même géométrie (slot 32px + espaces flex) pour un centrage exact */}
      <div className="mt-1.5 flex items-center">
        {steps.map((label, index) => (
          <div key={index} className="contents">
            <div className="flex w-8 shrink-0 justify-center px-2">
              <span
                className={`max-w-[9rem] text-center text-xs transition-colors duration-200 ${
                  index === current ? "font-medium text-ui-fg-base" : "text-ui-fg-muted"
                }`}
              >
                {label}
              </span>
            </div>
            {index < last && <div className="mx-2 flex-1" />}
          </div>
        ))}
      </div>
    </div>
  )
}