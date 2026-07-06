# Plugin Styling Guide

This document defines CSS conventions for Juggler plugins to ensure consistent styling and avoid conflicts between plugins and host styles.

## Architecture Overview

Juggler uses **Light DOM** (no Shadow DOM) with external stylesheets. This means:
- All CSS is global and can affect any element
- Plugins share CSS with the host application
- Naming conventions are critical to avoid conflicts

## CSS Custom Properties (Design Tokens)

Plugins **must** use these CSS variables instead of hardcoded values:

### Colors

```css
/* Background */
--bg-primary      /* Main background */
--bg-secondary    /* Secondary/sidebar background */
--bg-raised       /* Elevated surfaces */
--border-color    /* Borders */

/* Text */
--text-primary    /* Main text */
--text-secondary  /* Muted text */
--text-tertiary   /* Very muted text */

/* Accents */
--accent-blue     /* Links, info */
--accent-green    /* Success, positive */
--accent-yellow   /* Warning, caution */
--accent-red      /* Error, danger */
--accent-purple   /* Special actions */
```

### Typography

```css
--font-mono       /* Code, file paths */
--font-sans       /* UI text */
--font-ui         /* Menus, labels */
```

### Z-Index Scale

Plugins should use z-index sparingly. Available layers:

```css
--z-base: 1       /* Default stacking */
--z-raised: 10    /* Slightly elevated - MAX for plugins */
--z-controls: 100 /* Reserved for host controls */
--z-dropdown: 1000/* Reserved for host dropdowns */
--z-modal: 10000  /* Reserved for host modals */
```

**Plugin z-index limit:** Use only `var(--z-base)` or `var(--z-raised)`. Higher layers are reserved for host UI.

## Stable Classes (Public API)

These classes are stable and safe for plugins to use:

### Context Item Content Structure

Context item plugins render their content via `createExpandedView()` and `createCollapsedView()` methods. The host wraps these in a container with color preset:

```html
<!-- Properties panel / plugin catalog -->
<div class="ci-expanded-content color-blue">
  <!-- Plugin's createExpandedView() content goes here -->
</div>

<div class="ci-collapsed-content color-blue">
  <!-- Plugin's createCollapsedView() content goes here -->
</div>
```

### Color Presets

20 color presets available via `color-{name}`:

```
slate, blue, indigo, purple, magenta, pink, red, orange,
amber, yellow, lime, green, emerald, teal, cyan, sky,
brown, stone, zinc, crimson
```

### Utility Classes

```css
.ci-badge           /* Small label pill */
.ci-badge-label     /* Text inside badge */
.ci-code-content    /* Code/monospace content area */
.ci-empty-state     /* Empty state message */
.ci-error-state     /* Error message styling */
```

## Naming Convention for Plugin Classes

When adding custom styles inside context item content (`.ci-expanded-content` or `.ci-collapsed-content`), use the prefix pattern:

```
ci-{pluginId}-{element}
```

### Examples

```css
/* Good - properly prefixed */
.ci-tree-node { }
.ci-tree-folder { }
.ci-search-result { }
.ci-search-highlight { }

/* Bad - generic names risk collision */
.node { }
.result { }
.highlight { }
```

## Theme Compatibility

All plugins **must** support both dark and light themes. The easiest way:

```css
/* Use CSS variables - automatically adapts to theme */
.ci-myplugin-item {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

/* Only add theme-specific overrides if absolutely necessary */
:root[data-theme="light"] .ci-myplugin-item {
  /* light-mode specific adjustments */
}
```

## Forbidden Patterns

### Never Use

1. **Hardcoded colors in CSS or JS**
   ```css
   /* Bad */
   color: #ff0000;
   background: rgb(255, 0, 0);
   ```

2. **Pixel units (except 1px borders)**
   ```css
   /* Bad */
   padding: 16px;
   font-size: 14px;

   /* Good */
   padding: 1rem;
   font-size: 0.875rem;
   border: 1px solid var(--border-color); /* 1px borders OK */
   ```

3. **Inline styles in JS for theming**
   ```javascript
   // Bad
   element.style.color = '#00ff00';

   // Good
   element.classList.add('success');
   ```

4. **Shadow DOM**
   ```javascript
   // Bad - breaks global styling
   this.attachShadow({ mode: 'open' });
   ```

5. **!important (except for third-party overrides)**
   ```css
   /* Bad - specificity wars */
   color: red !important;
   ```

## Example: Well-Styled Plugin Content

```javascript
// In your plugin's getContextText() method
getContextText() {
  return `
    <div class="ci-myplugin-container">
      <div class="ci-myplugin-header">
        <span class="ci-badge">
          <span class="ci-badge-label">Status</span>
        </span>
      </div>
      <div class="ci-code-content">
        <pre><code>${this.data.content}</code></pre>
      </div>
    </div>
  `;
}
```

```css
/* In context-items.css or a dedicated plugin CSS section */
.ci-myplugin-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ci-myplugin-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: var(--bg-secondary);
  border-radius: 0.25rem;
}
```

## Checklist Before Submitting Plugin

- [ ] All colors use CSS variables
- [ ] All sizes use rem units (except 1px borders)
- [ ] Custom classes use `ci-{pluginId}-` prefix
- [ ] Tested in both dark and light themes
- [ ] No !important declarations
- [ ] No inline styles for colors/theming
- [ ] z-index uses only --z-base or --z-raised
