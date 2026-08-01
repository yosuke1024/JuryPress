(function() {
  const JURYPRESS_BASE_URL = 'https://pixapps.ai/jurypress/';

  // Navigation Data
  const navigationData = [
    {
      id: 'products',
      label: { ja: 'Products', en: 'Products' },
      children: [
        { id: 'pixmeal', label: { ja: 'PixMeal', en: 'PixMeal' }, href: '/pixmeal/', status: { ja: 'Live', en: 'Live' } },
        { id: 'pixwork', label: { ja: 'PixWork', en: 'PixWork' }, href: '/pixwork/', status: { ja: 'Coming Soon', en: 'Coming Soon' } },
        { id: 'pixtale', label: { ja: 'PixTale', en: 'PixTale' }, href: '/pixtale/', status: { ja: 'Live', en: 'Live' } },
        { id: 'simple-games', label: { ja: 'Simple Games', en: 'Simple Games' }, href: '/simple-games/', status: { ja: 'Coming Soon', en: 'Coming Soon' } }
      ]
    },
    {
      id: 'open-source',
      label: { ja: 'Open Source', en: 'Open Source' },
      children: [
        { id: 'judgie-ai', label: { ja: 'Judgie-AI', en: 'Judgie-AI' }, href: 'https://github.com/yosuke1024/Judgie-AI', external: true },
        { id: 'lightcrawl', label: { ja: 'LightCrawl', en: 'LightCrawl' }, href: 'https://github.com/yosuke1024/LightCrawl', status: { ja: 'Discontinued', en: 'Discontinued' }, external: true }
      ]
    },
    {
      id: 'jurypress',
      label: { ja: 'JuryPress', en: 'JuryPress' },
      href: JURYPRESS_BASE_URL
    },
    {
      id: 'build-notes',
      label: { ja: 'Build Notes', en: 'Build Notes' },
      href: '/build-notes/'
    }
  ];

  // Which navs belong in the second tier. A page opts in — by id, by class, or
  // by the `data-context-navigation` attribute the JuryPress build emits. Must
  // stay in step with the ContextNavigation rules in global-header.css.
  const CONTEXT_NAV_SELECTOR = '#navbar, .site-header, nav[data-context-navigation]';

  // Names for the pages still on the older `supportedLocales` config, which say
  // which languages they have but not what to call them. A page that declares
  // its own languages carries its own names, so this table does not grow when
  // the site gains a language.
  const LANGUAGE_NAMES = {
    ja: '日本語',
    en: 'English',
    th: 'ไทย',
    es: 'Español'
  };

  let pageConfig = null;
  let headerState = null;

  // A page declares its own languages: what each is called, and — when a language
  // is its own URL — where it lives. The header renders that list; it does not own
  // it. Returns null for anything malformed, so the page falls back to the older
  // `supportedLocales` form instead of rendering a broken switch.
  function readDeclaredLanguages(languages) {
    if (!Array.isArray(languages) || languages.length === 0) {
      return null;
    }

    const entries = [];
    const seen = [];
    for (const entry of languages) {
      if (!entry || typeof entry.code !== 'string' || !entry.code ||
          typeof entry.label !== 'string' || !entry.label) {
        console.error('pixapps-page-config: every language needs a code and a label', entry);
        return null;
      }
      // Two entries for one language make "which one is current" unanswerable,
      // and the switch would offer the same language twice.
      if (seen.indexOf(entry.code) !== -1) {
        console.error('pixapps-page-config: language listed twice', entry.code);
        return null;
      }
      seen.push(entry.code);

      // Site-relative only. The switch points at another page of this site, so
      // a scheme, a host, or a protocol-relative `//` is a mistake at best —
      // and `javascript:` in an href the header writes onto an anchor is worse.
      if (entry.href !== undefined && entry.href !== null) {
        if (typeof entry.href !== 'string' || entry.href.charAt(0) !== '/' ||
            entry.href.charAt(1) === '/') {
          console.error('pixapps-page-config: href must be a site-relative path', entry.href);
          return null;
        }
      }

      entries.push({
        code: entry.code,
        label: entry.label,
        href: (typeof entry.href === 'string' && entry.href) ? entry.href : null,
        current: entry.current === true
      });
    }

    // Every language is its own URL, or none is. A half-linked list would send
    // some languages to a sibling page and swap the rest in place.
    const linked = entries.filter(entry => entry.href).length;
    if (linked > 0 && linked < entries.length) {
      console.error('pixapps-page-config: give every language an href, or give none of them one');
      return null;
    }

    const marked = entries.filter(entry => entry.current);
    if (marked.length > 1) {
      console.error('pixapps-page-config: more than one language marked current');
      return null;
    }

    let currentCode;
    if (marked.length === 1) {
      currentCode = marked[0].code;
    } else {
      // Nothing marked: fall back to what the document already says it is, then
      // to the first entry.
      const declared = normalizeLocale(document.documentElement.lang);
      const match = entries.find(entry => entry.code === declared);
      currentCode = match ? match.code : entries[0].code;
    }

    return {
      entries: entries,
      // One language per URL only pays off once there is somewhere to go.
      linkMode: linked === entries.length && entries.length >= 2,
      currentCode: currentCode
    };
  }

  // Read config from page script tag
  function readPageConfig() {
    const configEl = document.getElementById('pixapps-page-config');
    if (configEl) {
      try {
        const parsed = JSON.parse(configEl.textContent);
        if (parsed && parsed.pageId) {
          const declared = readDeclaredLanguages(parsed.languages);
          if (declared) {
            return {
              pageId: parsed.pageId,
              languages: declared.entries,
              linkMode: declared.linkMode,
              declaredLocale: declared.currentCode,
              supportedLocales: declared.entries.map(entry => entry.code),
              defaultLocale: parsed.defaultLocale || declared.entries[0].code
            };
          }
          if (Array.isArray(parsed.supportedLocales)) {
            return {
              pageId: parsed.pageId,
              supportedLocales: parsed.supportedLocales,
              defaultLocale: parsed.defaultLocale || 'ja'
            };
          }
        }
      } catch (e) {
        console.error('Failed to parse pixapps-page-config:', e);
      }
    }

    // Fallback for pages without config element (e.g. JuryPress or static routes)
    const path = window.location.pathname;
    const isJuryPress = /\/jurypress(\/|$)/.test(path) || !!document.querySelector('.jurypress-wordmark') || !!document.querySelector('.site-header');
    if (isJuryPress) {
      return {
        pageId: 'jurypress',
        supportedLocales: ['en'],
        defaultLocale: 'en'
      };
    }

    return {
      pageId: 'default',
      supportedLocales: ['ja', 'en'],
      defaultLocale: 'ja'
    };
  }

  function normalizeLocale(locale) {
    if (!locale) return '';
    return locale.toLowerCase().split('-')[0];
  }

  // Resolve initial locale with priority: 1. saved, 2. browser, 3. default
  function resolveInitialLocale(config) {
    const saved = localStorage.getItem('pixapps-locale');
    if (saved && config.supportedLocales.includes(saved)) {
      return saved;
    }

    const browserLocales = [
      ...(navigator.languages || []),
      navigator.language
    ]
      .filter(Boolean)
      .map(normalizeLocale);

    const browserMatch = browserLocales.find(locale =>
      config.supportedLocales.includes(locale)
    );

    return browserMatch || config.defaultLocale;
  }

  // Initialize state once
  function initializeState() {
    pageConfig = readPageConfig();
    headerState = {
      pageId: pageConfig.pageId,
      supportedLocales: [...pageConfig.supportedLocales],
      defaultLocale: pageConfig.defaultLocale,
      languages: pageConfig.languages || null,
      linkMode: !!pageConfig.linkMode,
      // With one language per URL the page's own declaration decides, so a
      // locale stored while reading some other page cannot relabel this one —
      // which is what would leave a Japanese page calling itself English to a
      // screen reader and to a crawler.
      currentLocale: pageConfig.linkMode
        ? pageConfig.declaredLocale
        : resolveInitialLocale(pageConfig)
    };

    // Apply resolved locale attributes to HTML/Body immediately
    document.documentElement.lang = headerState.currentLocale;
    document.body.setAttribute('data-lang', headerState.currentLocale);
  }

  // Unified locale modifier. Swap-mode only: where each language is its own URL
  // the switch is a link, and following it is the whole mechanism — nothing is
  // stored, and this page's language never changes under the reader.
  function setLocale(locale) {
    if (!headerState || headerState.linkMode || !headerState.supportedLocales.includes(locale)) {
      return;
    }

    headerState.currentLocale = locale;
    localStorage.setItem('pixapps-locale', locale);
    document.documentElement.lang = locale;
    document.body.setAttribute('data-lang', locale);

    // Re-render the global header with the new state
    replaceHeader();

    // Notify the host page to update its contents
    window.dispatchEvent(
      new CustomEvent('pixapps:locale-change', {
        detail: { locale }
      })
    );
  }

  // Helper: Get Supported Locales
  function getSupportedLocales() {
    return headerState ? headerState.supportedLocales : ['ja', 'en'];
  }

  // Helper: Get Current Language
  function getLocale() {
    return headerState ? headerState.currentLocale : 'ja';
  }

  // What to call a language. The page's own declaration wins — that is the whole
  // point of declaring it — and the table covers the pages that declare only
  // which languages they have. The code itself is the last resort, so a language
  // nobody has named renders as something rather than as "undefined".
  function localeLabel(code) {
    const declared = (headerState && headerState.languages)
      ? headerState.languages.find(entry => entry.code === code)
      : null;
    if (declared) return declared.label;
    return LANGUAGE_NAMES[code] || code.toUpperCase();
  }

  // Helper: Check active navigation group
  function getActiveItem(path) {
    if (/\/pixmeal(\/|$)/.test(path) || /\/pixwork(\/|$)/.test(path) || /\/pixtale(\/|$)/.test(path) || /\/simple-games(\/|$)/.test(path)) {
      return 'products';
    }
    if (/\/marketplace(\/|$)/.test(path) || path.includes('github.com/yosuke1024/Judgie-AI') || path.includes('github.com/yosuke1024/LightCrawl')) {
      return 'open-source';
    }
    if (/\/jurypress(\/|$)/.test(path)) {
      return 'jurypress';
    }
    if (/\/build-notes(\/|$)/.test(path)) {
      return 'build-notes';
    }
    return null;
  }

  // Send Google Analytics event safely
  function trackClick(group, target) {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'navigation_click', {
        navigation_location: 'header',
        navigation_group: group,
        navigation_target: target,
        current_path: window.location.pathname
      });
    }
  }

  // DOM builder
  function buildHeader() {
    const locale = getLocale();
    const activeGroup = getActiveItem(window.location.pathname);
    const path = window.location.pathname;

    // Detect ContextNavigation and links
    const localNavLinks = [];
    let localNavTitle = '';
    const contextNav = document.querySelector(CONTEXT_NAV_SELECTOR);
    if (contextNav) {
      // Find local title
      const brandLogoEl = contextNav.querySelector('.nav-logo, .jurypress-wordmark');
      if (brandLogoEl) {
        localNavTitle = brandLogoEl.textContent.trim();
      } else {
        if (/\/pixmeal(\/|$)/.test(path)) localNavTitle = 'PixMeal';
        else if (/\/pixwork(\/|$)/.test(path)) localNavTitle = 'PixWork';
        else if (/\/pixtale(\/|$)/.test(path)) localNavTitle = 'PixTale';
        else if (/\/simple-games(\/|$)/.test(path)) localNavTitle = 'Simple Games';
        else if (/\/jurypress(\/|$)/.test(path)) localNavTitle = 'JuryPress';
      }

      // Parse links
      const links = contextNav.querySelectorAll('a:not(.nav-parent):not(.pixapps-link):not(.nav-logo):not(.jurypress-wordmark)');
      links.forEach(a => {
        if (a.id === 'langToggle' || a.classList.contains('lang-toggle') || a.href.includes('javascript:')) return;
        
        let label = '';
        const targetSpan = a.querySelector(`[data-${locale}]`);
        if (targetSpan) {
          label = targetSpan.textContent.trim();
        } else {
          const targetClassSpan = a.querySelector(`.lang-${locale}`);
          if (targetClassSpan) {
            label = targetClassSpan.textContent.trim();
          } else {
            let textParts = [];
            a.childNodes.forEach(node => {
              if (node.nodeType === 3) { // Node.TEXT_NODE
                textParts.push(node.textContent);
              } else if (node.nodeType === 1) { // Node.ELEMENT_NODE
                const element = node;
                const hasLocaleAttrs = Array.from(element.attributes).some(attr => attr.name.startsWith('data-'));
                if (hasLocaleAttrs) {
                  if (element.hasAttribute(`data-${locale}`)) {
                    textParts.push(element.textContent);
                  }
                } else if (element.classList.contains(`lang-${locale}`)) {
                  textParts.push(element.textContent);
                } else if (!Array.from(element.classList).some(c => c.startsWith('lang-') || c.startsWith('data-'))) {
                  textParts.push(element.textContent);
                }
              }
            });
            label = textParts.join('').trim();
          }
        }

        if (!label) {
          label = a.textContent.trim();
        }

        localNavLinks.push({
          label: label,
          href: a.getAttribute('href'),
          active: a.getAttribute('aria-current') === 'page' || a.classList.contains('active')
        });
      });

      // Hide family brand details in local nav for cleaner UI
      const brandLeft = contextNav.querySelector('.nav-left, .family-brand');
      if (brandLeft) {
        const familyPrefix = brandLeft.querySelector('.pixapps-link');
        const divider = brandLeft.querySelector('.divider');
        if (familyPrefix) familyPrefix.style.display = 'none';
        if (divider) divider.style.display = 'none';
        
        const parentLink = brandLeft.querySelector('.nav-parent');
        if (parentLink) parentLink.style.display = 'none';
      }

      // Hide extra language and mobile toggles in local nav
      const localLang = contextNav.querySelector('#langToggle, .lang-toggle, #langSelect, .lang-select');
      if (localLang) localLang.style.display = 'none';
      
      const localBurger = contextNav.querySelector('.menu-toggle, .mobile-menu-toggle, .mobile-menu-container');
      if (localBurger) localBurger.style.display = 'none';
    }

    // Header Element
    const header = document.createElement('header');
    header.className = 'global-header-container';
    header.setAttribute('data-global-header', 'true');

    // Outer Nav
    const nav = document.createElement('nav');
    nav.className = 'global-header-nav';
    header.appendChild(nav);

    // Brand Logo — official PixApps brand icon. The link's own "PixApps" text is
    // its accessible name, so the icon is decorative.
    const brand = document.createElement('a');
    brand.href = '/';
    brand.className = 'global-header-brand';
    brand.innerHTML = `
      <img src="/brand/pixapps-icon.svg" alt="" aria-hidden="true" width="24" height="24" class="global-header-logo-img">
      <span>PixApps</span>
    `;
    brand.addEventListener('click', () => trackClick('primary', 'home'));
    nav.appendChild(brand);

    // Desktop Navigation Links
    const linksContainer = document.createElement('div');
    linksContainer.className = 'global-header-links';
    nav.appendChild(linksContainer);

    navigationData.forEach(item => {
      if (item.children) {
        // Dropdown Menu Container
        const dropdown = document.createElement('div');
        dropdown.className = `global-header-dropdown ${activeGroup === item.id ? 'active' : ''}`;
        
        const button = document.createElement('button');
        button.className = 'global-header-dropdown-btn';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', `menu-${item.id}`);
        button.innerHTML = `${item.label.en} <span class="global-header-arrow">▾</span>`;
        dropdown.appendChild(button);

        const menu = document.createElement('div');
        menu.className = 'global-header-dropdown-menu';
        menu.id = `menu-${item.id}`;
        menu.setAttribute('role', 'menu');
        dropdown.appendChild(menu);

        item.children.forEach(child => {
          const link = document.createElement('a');
          link.href = child.href;
          link.setAttribute('role', 'menuitem');
          link.className = 'global-header-menuitem';
          
          if (child.external) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          }

          let statusBadge = '';
          if (child.status) {
            const statusClass = child.status.en.toLowerCase().replace(/\s+/g, '-');
            statusBadge = `<span class="global-header-status status-${statusClass}">${child.status.en}</span>`;
          }

          const extIcon = child.external ? '<span class="global-header-ext-icon">↗</span>' : '';

          link.innerHTML = `
            <span class="global-header-menuitem-label">${child.label.en}${extIcon}</span>
            ${statusBadge}
          `;

          link.addEventListener('click', () => {
            trackClick(item.id, child.id);
            closeAllDropdowns();
          });
          menu.appendChild(link);
        });

        // Dropdown toggle events (Click & Focus)
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = button.getAttribute('aria-expanded') === 'true';
          closeAllDropdowns();
          if (!isExpanded) {
            dropdown.classList.add('open');
            button.setAttribute('aria-expanded', 'true');
          }
        });

        // Hover support
        dropdown.addEventListener('mouseenter', () => {
          closeAllDropdowns();
          dropdown.classList.add('open');
          button.setAttribute('aria-expanded', 'true');
        });
        dropdown.addEventListener('mouseleave', () => {
          dropdown.classList.remove('open');
          button.setAttribute('aria-expanded', 'false');
        });

        linksContainer.appendChild(dropdown);
      } else {
        // Direct Link
        const link = document.createElement('a');
        link.className = `global-header-link ${activeGroup === item.id ? 'active' : ''}`;
        if (activeGroup === item.id) {
          link.setAttribute('aria-current', 'page');
        }
        
        let finalHref = item.href;
        if (item.id === 'build-notes' && locale === 'en') {
          finalHref = '/en/build-notes/';
        }
        
        link.href = finalHref;
        link.textContent = item.label.en;
        link.addEventListener('click', () => trackClick('primary', item.id));
        linksContainer.appendChild(link);
      }
    });

    // Right Section (Language Toggle & Hamburger)
    const rightSec = document.createElement('div');
    rightSec.className = 'global-header-right';
    nav.appendChild(rightSec);

    // Language selector rendering based on supported locales count
    const langDropdown = document.createElement('div');
    langDropdown.className = 'global-header-lang-dropdown';

    const numLocales = getSupportedLocales().length;

    if (headerState && headerState.linkMode) {
      // One language per URL. The switch is a link to the sibling page, so it
      // cannot disagree with the language of the page it points at, and it
      // works without JavaScript deciding anything.
      const entries = headerState.languages;
      const currentEntry = entries.find(entry => entry.code === locale) || entries[0];

      if (entries.length === 2) {
        const other = entries.find(entry => entry !== currentEntry);
        const langLink = document.createElement('a');
        langLink.className = 'global-header-lang-btn';
        langLink.id = 'globalLangToggle';
        langLink.href = other.href;
        langLink.hreflang = other.code;
        langLink.textContent = other.code.toUpperCase();
        langLink.setAttribute('aria-label', `Switch to ${other.label}`);
        langLink.addEventListener('click', () => trackClick('lang_toggle', other.code));
        langDropdown.appendChild(langLink);
      } else {
        const langBtn = document.createElement('button');
        langBtn.className = 'global-header-lang-btn';
        langBtn.id = 'globalLangToggle';
        langBtn.setAttribute('aria-haspopup', 'menu');
        langBtn.setAttribute('aria-expanded', 'false');
        langBtn.setAttribute('aria-controls', 'global-lang-menu');
        // The code rather than the language's own name: the button is then the
        // same width whichever languages a page publishes, and however many.
        langBtn.innerHTML = `${currentEntry.code.toUpperCase()} <span class="global-header-arrow">▾</span>`;
        langDropdown.appendChild(langBtn);

        const langMenu = document.createElement('div');
        langMenu.className = 'global-header-lang-menu';
        langMenu.id = 'global-lang-menu';
        langMenu.setAttribute('role', 'menu');
        langMenu.setAttribute('aria-label', 'Language selection');
        langDropdown.appendChild(langMenu);

        entries.forEach(entry => {
          const item = document.createElement('a');
          item.className = `global-header-lang-menuitem ${entry === currentEntry ? 'active' : ''}`;
          item.setAttribute('role', 'menuitem');
          item.href = entry.href;
          item.hreflang = entry.code;
          // Each name is written in its own language; say so, or a screen
          // reader pronounces "Español" with the voice of the current page.
          item.lang = entry.code;
          item.textContent = entry.label;
          if (entry === currentEntry) {
            item.setAttribute('aria-current', 'true');
          }
          item.addEventListener('click', () => trackClick('lang_dropdown', entry.code));
          langMenu.appendChild(item);
        });

        langBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = langBtn.getAttribute('aria-expanded') === 'true';
          closeAllDropdowns();
          if (!isExpanded) {
            langDropdown.classList.add('open');
            langBtn.setAttribute('aria-expanded', 'true');
          }
        });

        langDropdown.addEventListener('mouseenter', () => {
          closeAllDropdowns();
          langDropdown.classList.add('open');
          langBtn.setAttribute('aria-expanded', 'true');
        });
        langDropdown.addEventListener('mouseleave', () => {
          langDropdown.classList.remove('open');
          langBtn.setAttribute('aria-expanded', 'false');
        });
      }
    } else if (numLocales <= 1) {
      // 1. Single Locale
      const langLabel = document.createElement('span');
      langLabel.className = 'global-header-lang-label-static';
      langLabel.textContent = 'English only';
      langLabel.style.opacity = '0.6';
      langLabel.style.fontSize = '0.9rem';
      langLabel.style.padding = '0 12px';
      langDropdown.appendChild(langLabel);
    } else if (numLocales === 2) {
      // 2. Binary Toggle (EN <-> JA)
      const langBtn = document.createElement('button');
      langBtn.className = 'global-header-lang-btn';
      langBtn.id = 'globalLangToggle';
      
      const otherLocale = getSupportedLocales().find(l => l !== locale) || 'en';
      langBtn.textContent = otherLocale.toUpperCase();
      langBtn.setAttribute('aria-label', `Switch to ${localeLabel(otherLocale)}`);
      
      langBtn.addEventListener('click', () => {
        trackClick('lang_toggle', otherLocale);
        setLocale(otherLocale);
      });
      langDropdown.appendChild(langBtn);
    } else {
      // 3. 3+ Locales (Dropdown Selection Menu)
      const langBtn = document.createElement('button');
      langBtn.className = 'global-header-lang-btn';
      langBtn.id = 'globalLangToggle';
      langBtn.setAttribute('aria-haspopup', 'listbox');
      langBtn.setAttribute('aria-expanded', 'false');
      langBtn.setAttribute('aria-controls', 'global-lang-menu');
      langBtn.innerHTML = `${localeLabel(locale)} <span class="global-header-arrow">▾</span>`;
      langDropdown.appendChild(langBtn);

      const langMenu = document.createElement('div');
      langMenu.className = 'global-header-lang-menu';
      langMenu.id = 'global-lang-menu';
      langMenu.setAttribute('role', 'listbox');
      langMenu.setAttribute('aria-label', 'Language selection');
      langDropdown.appendChild(langMenu);

      getSupportedLocales().forEach(lang => {
        const item = document.createElement('button');
        item.className = `global-header-lang-menuitem ${lang === locale ? 'active' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', lang === locale ? 'true' : 'false');
        item.textContent = localeLabel(lang);

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (lang === locale) {
            closeAllDropdowns();
            return;
          }

          trackClick('lang_dropdown', lang);
          setLocale(lang);
        });
        langMenu.appendChild(item);
      });

      // Toggle events
      langBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExpanded = langBtn.getAttribute('aria-expanded') === 'true';
        closeAllDropdowns();
        if (!isExpanded) {
          langDropdown.classList.add('open');
          langBtn.setAttribute('aria-expanded', 'true');
        }
      });

      langDropdown.addEventListener('mouseenter', () => {
        closeAllDropdowns();
        langDropdown.classList.add('open');
        langBtn.setAttribute('aria-expanded', 'true');
      });
      langDropdown.addEventListener('mouseleave', () => {
        langDropdown.classList.remove('open');
        langBtn.setAttribute('aria-expanded', 'false');
      });
    }
    rightSec.appendChild(langDropdown);

    // Hamburger Menu Button
    const burger = document.createElement('button');
    burger.className = 'global-header-burger';
    burger.setAttribute('aria-label', 'Toggle Mobile Menu');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-controls', 'global-header-drawer');
    burger.innerHTML = `
      <span class="global-header-burger-bar"></span>
      <span class="global-header-burger-bar"></span>
      <span class="global-header-burger-bar"></span>
    `;
    rightSec.appendChild(burger);

    // Mobile Drawer Overlay
    const drawer = document.createElement('div');
    drawer.className = 'global-header-drawer';
    drawer.id = 'global-header-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Mobile Navigation');
    drawer.setAttribute('aria-hidden', 'true');

    const drawerContent = document.createElement('div');
    drawerContent.className = 'global-header-drawer-content';
    drawer.appendChild(drawerContent);

    // Mobile Brand Logo
    const drawerBrand = brand.cloneNode(true);
    drawerBrand.addEventListener('click', () => {
      closeMobileMenu();
      trackClick('primary', 'home');
    });
    drawerContent.appendChild(drawerBrand);

    // Mobile Menu List
    const mobileList = document.createElement('div');
    mobileList.className = 'global-header-mobile-list';
    drawerContent.appendChild(mobileList);

    // Mobile Section: PixApps
    const globalSectionTitle = document.createElement('div');
    globalSectionTitle.className = 'global-header-mobile-section-title';
    globalSectionTitle.textContent = 'PixApps';
    mobileList.appendChild(globalSectionTitle);

    navigationData.forEach(item => {
      if (item.children) {
        const accordion = document.createElement('div');
        accordion.className = 'global-header-accordion';

        const trigger = document.createElement('button');
        trigger.className = 'global-header-accordion-trigger';
        trigger.innerHTML = `${item.label.en} <span class="global-header-accordion-icon">▾</span>`;
        accordion.appendChild(trigger);

        const panel = document.createElement('div');
        panel.className = 'global-header-accordion-panel';
        accordion.appendChild(panel);

        item.children.forEach(child => {
          const link = document.createElement('a');
          link.href = child.href;
          link.className = 'global-header-accordion-link';
          
          if (child.external) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          }

          let statusBadge = '';
          if (child.status) {
            const statusClass = child.status.en.toLowerCase().replace(/\s+/g, '-');
            statusBadge = `<span class="global-header-status status-${statusClass}">${child.status.en}</span>`;
          }

          const extIcon = child.external ? '<span class="global-header-ext-icon">↗</span>' : '';

          link.innerHTML = `
            <span>${child.label.en}${extIcon}</span>
            ${statusBadge}
          `;

          link.addEventListener('click', () => {
            trackClick(item.id, child.id);
            closeMobileMenu();
          });
          panel.appendChild(link);
        });

        trigger.addEventListener('click', () => {
          const isOpen = accordion.classList.contains('open');
          drawerContent.querySelectorAll('.global-header-accordion').forEach(acc => {
            acc.classList.remove('open');
          });
          if (!isOpen) {
            accordion.classList.add('open');
          }
        });

        mobileList.appendChild(accordion);
      } else {
        const link = document.createElement('a');
        link.className = `global-header-mobile-link ${activeGroup === item.id ? 'active' : ''}`;
        
        let finalHref = item.href;
        if (item.id === 'build-notes' && locale === 'en') {
          finalHref = '/en/build-notes/';
        }
        
        link.href = finalHref;
        link.textContent = item.label.en;
        link.addEventListener('click', () => {
          trackClick('primary', item.id);
          closeMobileMenu();
        });
        mobileList.appendChild(link);
      }
    });

    // Mobile Section: Context Navigation (Current Section)
    if (localNavLinks.length > 0) {
      const separator = document.createElement('hr');
      separator.className = 'global-header-mobile-separator';
      mobileList.appendChild(separator);

      const localSectionTitle = document.createElement('div');
      localSectionTitle.className = 'global-header-mobile-section-title';
      localSectionTitle.textContent = localNavTitle || 'Current Section';
      mobileList.appendChild(localSectionTitle);

      localNavLinks.forEach(linkData => {
        const link = document.createElement('a');
        link.className = `global-header-mobile-link ${linkData.active ? 'active' : ''}`;
        link.href = linkData.href;
        link.textContent = linkData.label;
        link.addEventListener('click', () => {
          trackClick('local_navigation', linkData.label);
          closeMobileMenu();
        });
        mobileList.appendChild(link);
      });
    }

    // Mobile Language List in Drawer
    if (headerState && headerState.linkMode) {
      const mobileLangList = document.createElement('div');
      mobileLangList.className = 'global-header-mobile-lang-list';

      headerState.languages.forEach(entry => {
        const item = document.createElement('a');
        item.className = `global-header-mobile-lang-item ${entry.code === locale ? 'active' : ''}`;
        item.href = entry.href;
        item.hreflang = entry.code;
        item.lang = entry.code;
        item.textContent = entry.label;
        if (entry.code === locale) {
          item.setAttribute('aria-current', 'true');
        }
        item.addEventListener('click', () => {
          trackClick('lang_dropdown', entry.code);
          closeMobileMenu();
        });
        mobileLangList.appendChild(item);
      });
      drawerContent.appendChild(mobileLangList);
    } else if (numLocales > 1) {
      const mobileLangList = document.createElement('div');
      mobileLangList.className = 'global-header-mobile-lang-list';

      getSupportedLocales().forEach(lang => {
        const item = document.createElement('button');
        item.className = `global-header-mobile-lang-item ${lang === locale ? 'active' : ''}`;
        item.textContent = numLocales === 2 ? lang.toUpperCase() : localeLabel(lang);
        item.addEventListener('click', () => {
          closeMobileMenu();
          setLocale(lang);
        });
        mobileLangList.appendChild(item);
      });
      drawerContent.appendChild(mobileLangList);
    }

    document.body.appendChild(drawer);

    // Event: Toggle mobile menu
    burger.addEventListener('click', () => {
      const isOpen = drawer.classList.contains('open');
      if (isOpen) {
        closeMobileMenu();
      } else {
        openMobileMenu();
      }
    });

    // Close on Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
        closeMobileMenu();
      }
    });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!header.contains(e.target)) {
        closeAllDropdowns();
      }
    });

    // Focus traps & accessibility for mobile drawer
    function openMobileMenu() {
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
      burger.classList.add('open');
      burger.setAttribute('aria-expanded', 'true');
      document.body.classList.add('global-header-no-scroll');
      
      setTimeout(() => {
        const focusable = drawer.querySelectorAll('a, button');
        if (focusable.length > 0) focusable[0].focus();
      }, 100);

      drawer.addEventListener('keydown', trapFocus);
    }

    function closeMobileMenu() {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      burger.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('global-header-no-scroll');
      drawer.removeEventListener('keydown', trapFocus);
      burger.focus();
    }

    function trapFocus(e) {
      const focusable = drawer.querySelectorAll('a, button');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    }

    function closeAllDropdowns() {
      header.querySelectorAll('.global-header-dropdown').forEach(dropdown => {
        dropdown.classList.remove('open');
        dropdown.querySelector('.global-header-dropdown-btn').setAttribute('aria-expanded', 'false');
      });
      
      const langDropdown = header.querySelector('.global-header-lang-dropdown');
      if (langDropdown) {
        langDropdown.classList.remove('open');
        const langToggle = langDropdown.querySelector('.global-header-lang-btn');
        if (langToggle) {
          langToggle.setAttribute('aria-expanded', 'false');
        }
      }
    }

    linksContainer.querySelectorAll('.global-header-dropdown').forEach(dropdown => {
      const btn = dropdown.querySelector('.global-header-dropdown-btn');
      const menuItems = dropdown.querySelectorAll('.global-header-menuitem');
      const lastItem = menuItems[menuItems.length - 1];

      if (lastItem) {
        lastItem.addEventListener('blur', () => {
          dropdown.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
        });
      }
    });

    return header;
  }

  // Replace existing header or mount global header
  function replaceHeader() {
    if (!headerState) {
      initializeState();
    }

    const locale = getLocale();
    document.documentElement.lang = locale;
    document.body.setAttribute('data-lang', locale);

    const existingGlobal = document.querySelector('.global-header-container');
    if (existingGlobal) {
      existingGlobal.remove();
    }
    const mobileDrawer = document.querySelector('.global-header-drawer');
    if (mobileDrawer) {
      mobileDrawer.remove();
    }

    const newHeader = buildHeader();
    const body = document.body;

    const placeholder = document.getElementById('global-header');
    if (placeholder) {
      placeholder.parentNode.replaceChild(newHeader, placeholder);
    } else {
      const navTarget = document.querySelector('nav');
      if (navTarget && !navTarget.classList.contains('global-header-nav')) {
        const isLocalNav = navTarget.id === 'navbar' || navTarget.querySelector('.nav-parent') || navTarget.querySelector('.nav-links a[href*="#"]');
        if (isLocalNav) {
          body.insertBefore(newHeader, body.firstChild);
        } else {
          navTarget.parentNode.replaceChild(newHeader, navTarget);
        }
      } else {
        body.insertBefore(newHeader, body.firstChild);
      }
    }

    const hasContextNav = !!document.querySelector(CONTEXT_NAV_SELECTOR);
    if (hasContextNav) {
      document.body.classList.add('has-context-nav');
    } else {
      document.body.classList.remove('has-context-nav');
    }

    const headerHeight = newHeader.offsetHeight || 64;
    document.documentElement.style.setProperty('--global-header-height', `${headerHeight}px`);
  }

  // Run mount on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', replaceHeader);
  } else {
    replaceHeader();
  }
})();
