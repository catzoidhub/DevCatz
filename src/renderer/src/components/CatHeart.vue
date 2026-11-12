<script setup lang="ts">
/**
 * Support Catzoid's mark (Catzoid #94): MrCatz's head (the Catzoid brand cat: Catzoid/art/logos/catzoid.svg, same
 * outline, ears and antenna) with a heart where the face is. Drawn in currentColor, so it takes the rail's muted
 * colour and the primary colour on hover; the heart is cut out (a mask) and shows whatever is behind it.
 */
const id = `cat-heart-${++count}`;
</script>
<script lang="ts">
let count = 0;
</script>

<template>
  <svg viewBox="172 132 680 680" fill="currentColor" stroke="currentColor" aria-hidden="true">
    <defs>
      <mask :id="id" maskUnits="userSpaceOnUse" x="172" y="132" width="680" height="680">
        <rect x="172" y="132" width="680" height="680" fill="#fff" stroke="none" />
        <path fill="#000" stroke="none" transform="translate(512 592) scale(150)" d="M0 .92C-.86 .36-1 -.12-1 -.42-1 -.78-.76-1-.48-1-.26-1-.09-.87 0-.68.09-.87.26-1 .48-1 .76-1 1-.78 1-.42 1-.12.86.36 0 .92Z" />
      </mask>
    </defs>
    <path d="M560 336 L582 196" fill="none" stroke-width="30" stroke-linecap="round" />
    <circle cx="584" cy="176" r="36" stroke="none" />
    <path :mask="`url(#${id})`" stroke-width="36" stroke-linejoin="round" d="M268 418 L246 222 L446 334 C 487 318, 537 318, 578 334 L778 222 L756 418 C 792 470, 808 528, 808 586 C 808 712, 676 790, 512 790 C 348 790, 216 712, 216 586 C 216 528, 232 470, 268 418 Z" />
  </svg>
</template>
