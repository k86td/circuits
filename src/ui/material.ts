/**
 * Enregistrement des composants Material 3 (@material/web) utilisés par l'interface.
 * Chaque import définit un élément personnalisé `<md-…>` ; la typographie M3 est injectée dans le document.
 */

import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/chips/chip-set.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/dialog/dialog.js";
import "@material/web/divider/divider.js";
import "@material/web/icon/icon.js";
import "@material/web/iconbutton/filled-tonal-icon-button.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import "@material/web/ripple/ripple.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/switch/switch.js";
import "@material/web/textfield/outlined-text-field.js";
import { styles as typescaleStyles } from "@material/web/typography/md-typescale-styles.js";

if (typescaleStyles.styleSheet) document.adoptedStyleSheets = [...document.adoptedStyleSheets, typescaleStyles.styleSheet];

export type { MdCheckbox } from "@material/web/checkbox/checkbox.js";
export type { MdFilterChip } from "@material/web/chips/filter-chip.js";
export type { MdDialog } from "@material/web/dialog/dialog.js";
export type { MdIconButton } from "@material/web/iconbutton/icon-button.js";
export type { MdMenu } from "@material/web/menu/menu.js";
export type { MdOutlinedSelect } from "@material/web/select/outlined-select.js";
export type { MdSlider } from "@material/web/slider/slider.js";
export type { MdSwitch } from "@material/web/switch/switch.js";
