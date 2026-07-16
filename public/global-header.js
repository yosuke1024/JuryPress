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
        { id: 'pixtale', label: { ja: 'PixTale', en: 'PixTale' }, href: '/pixtale/', status: { ja: 'Live', en: 'Live' } }
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

  let pageConfig = null;
  let headerState = null;

  // Read config from page script tag
  function readPageConfig() {
    const configEl = document.getElementById('pixapps-page-config');
    if (configEl) {
      try {
        const parsed = JSON.parse(configEl.textContent);
        if (parsed && parsed.pageId && Array.isArray(parsed.supportedLocales)) {
          return {
            pageId: parsed.pageId,
            supportedLocales: parsed.supportedLocales,
            defaultLocale: parsed.defaultLocale || 'ja'
          };
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
      currentLocale: resolveInitialLocale(pageConfig)
    };

    // Apply resolved locale attributes to HTML/Body immediately
    document.documentElement.lang = headerState.currentLocale;
    document.body.setAttribute('data-lang', headerState.currentLocale);
  }

  // Unified locale modifier
  function setLocale(locale) {
    if (!headerState || !headerState.supportedLocales.includes(locale)) {
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

  // Helper: Check active navigation group
  function getActiveItem(path) {
    if (/\/pixmeal(\/|$)/.test(path) || /\/pixwork(\/|$)/.test(path) || /\/pixtale(\/|$)/.test(path)) {
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
    const contextNav = document.querySelector('nav:not(.global-header-nav), #navbar, .site-header');
    if (contextNav) {
      // Find local title
      const brandLogoEl = contextNav.querySelector('.nav-logo, .jurypress-wordmark');
      if (brandLogoEl) {
        localNavTitle = brandLogoEl.textContent.trim();
      } else {
        if (/\/pixmeal(\/|$)/.test(path)) localNavTitle = 'PixMeal';
        else if (/\/pixwork(\/|$)/.test(path)) localNavTitle = 'PixWork';
        else if (/\/pixtale(\/|$)/.test(path)) localNavTitle = 'PixTale';
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

    // Brand Logo (Restored to approved logo.png)
    const brand = document.createElement('a');
    brand.href = '/';
    brand.className = 'global-header-brand';
    brand.innerHTML = `
      <img src="/logo.png" alt="PixApps Logo" class="global-header-logo-img">
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

    const langNames = {
      ja: '日本語',
      en: 'English',
      th: 'ไทย'
    };

    const numLocales = getSupportedLocales().length;

    if (numLocales <= 1) {
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
      langBtn.setAttribute('aria-label', `Switch to ${langNames[otherLocale]}`);
      
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
      langBtn.innerHTML = `${langNames[locale]} <span class="global-header-arrow">▾</span>`;
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
        item.textContent = langNames[lang];

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
    if (numLocales > 1) {
      const mobileLangList = document.createElement('div');
      mobileLangList.className = 'global-header-mobile-lang-list';

      getSupportedLocales().forEach(lang => {
        const item = document.createElement('button');
        item.className = `global-header-mobile-lang-item ${lang === locale ? 'active' : ''}`;
        item.textContent = numLocales === 2 ? lang.toUpperCase() : langNames[lang];
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

    const hasContextNav = !!document.querySelector('nav:not(.global-header-nav), #navbar, .site-header');
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
