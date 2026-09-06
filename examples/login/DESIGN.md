---
name: pgstencil login example
description: Native email sign-in forms on warm paper with forest controls.
colors:
  paper: '#f6f5f0'
  ink: '#203b2f'
  muted: '#526458'
  line: '#c7d0c6'
  accent: '#245e43'
  control-surface: '#fffefa'
  control-border: '#84968a'
  placeholder: '#68766c'
  focus: '#4a8060'
  on-accent: '#ffffff'
  accent-hover: '#194a32'
  accent-active: '#123e28'
  disabled: '#667c6e'
  error-surface: '#fff0eb'
  error-border: '#bf7666'
  error-ink: '#792e20'
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '17px'
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '17px'
    fontWeight: 600
    lineHeight: 1.6
  button:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '16px'
    fontWeight: 600
    lineHeight: 1.5
  note:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: '6px'
spacing:
  label-gap: '8px'
  control-block: '14px'
  inline-gap: '16px'
  action-gap: '20px'
  section-gap: '24px'
  outer-gap: '36px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.on-accent}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '14px 18px'
    width: '100%'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
  button-primary-active:
    backgroundColor: '{colors.accent-active}'
  button-primary-disabled:
    backgroundColor: '{colors.disabled}'
  button-text:
    backgroundColor: 'transparent'
    textColor: '{colors.accent}'
    padding: '0'
  input:
    backgroundColor: '{colors.control-surface}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '14px 16px'
    width: '100%'
  error:
    backgroundColor: '{colors.error-surface}'
    textColor: '{colors.error-ink}'
    rounded: '{rounded.control}'
    padding: '14px 16px'
---

# Design System: pgstencil login example

## Overview

**Creative North Star: "Warm paper and forest native forms"**

This small operational interface uses quiet surfaces, readable labels and familiar HTML controls. Forest green identifies actions; warm paper carries the page. Instructions and recovery links remain close to the task.

This record describes the implemented example in `src/style.css`, `src/views.ts` and `src/app.ts`, bounded to `examples/login`. Its direction contract is identified by seed `93f1c640`. The finish reviewer returned **ship**; mobile screenshots were unavailable, so responsive behavior below is verified from source only.

**Key Characteristics:**

- Restrained forest accent on warm paper.
- A narrow, single-column task area.
- Persistent labels, explicit errors and visible recovery.
- Native forms that work without client JavaScript.

## Colors

The restrained palette combines green-tinted neutrals with a single forest action accent.

### Primary

- **Forest accent:** primary buttons, links and the wordmark's punctuation; darker states distinguish interaction.
- **Focus green:** a shared outline for keyboard interaction.

### Neutral

- **Warm paper:** page background; **control surface:** slightly lighter input fill.
- **Forest ink:** main text; **muted green:** supporting copy and metadata.
- **Soft green line:** header, footer and inbox dividers; **control border:** stronger field boundary.
- **On-accent white:** primary button text; **placeholder:** subdued input examples.

Error surface, border and ink form a separate semantic treatment used with explicit error copy. Disabled controls use a muted green state.

**The Action Accent Rule.** Use forest green for actionable controls and links; keep supporting copy in muted ink.

## Typography

Body, labels and controls share the platform UI sans-serif stack. The compact hierarchy moves from supporting copy to body text and semibold labels; buttons use a slightly smaller semibold size. No external fonts are loaded.

The current page heading uses Georgia at `clamp(38px, 6vw, 54px)`, regular weight, with `1.12` line height. This installed display face is an observed craft-floor exception, deliberately excluded from normative typography tokens. The code input uses spaced monospace digits as a specialized entry treatment.

**The Visible Label Rule.** Keep a persistent label above each field; placeholder text supplies an example only.

## Layout

The task column is centered, capped at 480px, with 24px side clearance. Header and footer share a 1120px maximum width. Main content begins with a heading and instruction, followed by the form and relevant recovery actions. Repeated gaps separate labels, controls, actions and notes.

At widths up to 560px, header and footer padding reduces to 20px by 24px; main margins reduce to 54px above and 64px below. The footer stacks its text, and recovery actions wrap. Long email addresses wrap anywhere. These are source-defined behaviors, not a claim of mobile screenshot verification.

## Elevation & Depth

There are no shadows, gradients or animated transitions. Tonal input fills and thin dividers separate regions. Keyboard focus uses a 3px solid outline with a 4px offset.

**The Flat Surface Rule.** Use surface tone and borders for separation, preserving the existing flat form language.

## Shapes

Fields, primary buttons and error messages share softly rounded control corners. Inputs and errors have a 1px border; primary buttons have no border. Recovery buttons retain flat, underlined text treatment.

## Components

### Buttons

Primary actions span the form width, with semibold white text on forest green. Hover and active states darken the background; disabled styling changes the fill and cursor. Text buttons use underlined accent text and share link hover behavior. All actions expose keyboard focus.

Optional Google/GitHub actions use full-width bordered controls with a light surface and forest ink below the email form. A fieldset legend labels the alternatives. Account pages use the same controls for connecting providers and plain text for already connected methods. These are native POST forms with shared focus styling; no external logos or scripts are loaded.

### Inputs / Fields

Visible labels precede full-width light fields. Email input uses native email semantics and autocomplete. Code entry remains a single text field with numeric input hints, one-time-code autocomplete and an associated expiry note. Preserve leading zeroes and pasted spacing.

### Navigation

The header links the pgstencil wordmark to sign-in. A smaller Local inbox link appears only in development. Recovery links remain underlined and wrap alongside the resend form when space narrows.

### Errors and account details

Errors use a bordered warm red message with `role="alert"`, ahead of the relevant form. Recovery remains available after failed verification or delivery. Account metadata uses a definition list with muted terms and wrapping values.

## Do's and Don'ts

- **Do** preserve native form submission, explicit field labels and visible keyboard focus.
- **Do** keep recovery actions close to the failed or pending task.
- **Do** allow long email addresses and recovery actions to wrap.
- **Don't** replace visible labels with placeholders.
- **Don't** use color alone to communicate errors.
- **Don't** require client JavaScript for the sign-in flow.
