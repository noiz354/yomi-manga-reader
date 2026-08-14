/**
 * shared/ui — presentational primitives + design tokens (leaf layer).
 *
 * Tokens are the ONLY place colors/spacing/typography are defined; components
 * are presentational (no data logic, no feature imports, no fetches). Every
 * interactive primitive ships visible focus, label support, a ≥ 44×44 px touch
 * target, and reduced-motion-safe transitions. Stylesheets (`tokens.css`,
 * `base.css`) are imported by the root layout, not by the components.
 */
export * from './AppShell';
export * from './Button';
export * from './classNames';
export * from './Dialog';
export * from './FocusRegion';
export * from './FormField';
export * from './Link';
export * from './List';
export * from './StateRegion';
export * from './hydration';
