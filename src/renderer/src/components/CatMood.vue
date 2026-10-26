<script setup lang="ts">
/**
 * MrCatz with a mood: the Catzoid brand head (Catzoid/art/logos/catzoid.svg) pulling a face for toasts and
 * dialogs — happy for success, sad for an error, wide-eyed with a "!" for a warning, the brand's "< >" eyes for
 * info, and a tilted-ear "?" for a question. Fixed brand colours (white fur, indigo ink), so it reads the same on
 * a solid alert, a soft one and a dialog header; size it with a class (size-5 … size-9). The brand's "< >" eyes
 * stay for warning / info / question — the mood is in the brows, the mouth, a tilt of the head and a big sign the
 * cat peeks out from behind (an amber "!" triangle, a blue "i" disc, a violet "?" bubble): the sign reads at toast
 * size on its own, the cat gives it the face.
 */
export type CatMoodKind = 'success' | 'error' | 'warning' | 'info' | 'question';
defineProps<{ mood: CatMoodKind }>();
</script>

<template>
  <svg viewBox="0 0 1024 1024" aria-hidden="true" class="cat-mood" :class="`is-${mood}`">
    <defs>
      <linearGradient id="cm-fur" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFFFFF" />
        <stop offset="1" stop-color="#ECE9FF" />
      </linearGradient>
      <path id="cm-star" d="M0 -100 Q0 0 100 0 Q0 0 0 100 Q0 0 -100 0 Q0 0 0 -100 Z" />
    </defs>
    <!-- the head, lower and a little smaller than the brand tile: room for a badge at the top right -->
    <g :transform="`${mood === 'question' ? 'rotate(-9 512 560) ' : mood === 'warning' ? 'rotate(4 512 560) ' : ''}translate(${mood === 'success' || mood === 'error' ? '512 548' : '440 500'}) scale(${mood === 'success' || mood === 'error' ? 0.88 : 0.8}) translate(-512 -500)`">
      <!-- antenna: the "-oid" -->
      <path d="M560 336 L582 196" fill="none" stroke="#3B33A8" stroke-width="26" stroke-linecap="round" :opacity="mood === 'error' ? 0.5 : 1" />
      <circle cx="584" cy="176" r="32" fill="#2FD3BC" stroke="#FFFFFF" stroke-width="10" />
      <!-- fur, with a faint ink outline so the white head shows on pale backgrounds -->
      <path
        fill="url(#cm-fur)"
        stroke="url(#cm-fur)"
        stroke-width="36"
        stroke-linejoin="round"
        d="M268 418 L246 222 L446 334 C 487 318, 537 318, 578 334 L778 222 L756 418 C 792 470, 808 528, 808 586 C 808 712, 676 790, 512 790 C 348 790, 216 712, 216 586 C 216 528, 232 470, 268 418 Z"
      />
      <path
        fill="none"
        stroke="#3B33A8"
        stroke-opacity="0.32"
        stroke-width="18"
        stroke-linejoin="round"
        d="M268 418 L246 222 L446 334 C 487 318, 537 318, 578 334 L778 222 L756 418 C 792 470, 808 528, 808 586 C 808 712, 676 790, 512 790 C 348 790, 216 712, 216 586 C 216 528, 232 470, 268 418 Z"
      />
      <path fill="#6D5DF6" opacity="0.32" d="M300 404 L286 282 L420 356 Z" />
      <path fill="#6D5DF6" opacity="0.32" d="M724 404 L738 282 L604 356 Z" />

      <!-- eyes -->
      <g fill="none" stroke="#3B33A8" stroke-width="52" stroke-linecap="round" stroke-linejoin="round">
        <template v-if="mood === 'success'">
          <path d="M398 610 Q446 552 494 610" />
          <path d="M530 610 Q578 552 626 610" />
        </template>
        <template v-else-if="mood === 'error'">
          <path d="M404 622 Q446 654 488 622" />
          <path d="M536 622 Q578 654 620 622" />
          <path d="M392 566 L480 530" stroke-width="30" />
          <path d="M632 566 L544 530" stroke-width="30" />
        </template>
        <template v-else-if="mood === 'warning'">
          <!-- alarmed: wide eyes, brows up high -->
          <circle cx="446" cy="604" r="44" fill="#FFFFFF" stroke-width="24" />
          <circle cx="578" cy="604" r="44" fill="#FFFFFF" stroke-width="24" />
          <circle cx="452" cy="610" r="18" fill="#3B33A8" stroke="none" />
          <circle cx="584" cy="610" r="18" fill="#3B33A8" stroke="none" />
          <path d="M392 506 Q446 470 500 506" stroke-width="30" />
          <path d="M524 506 Q578 470 632 506" stroke-width="30" />
        </template>
        <template v-else-if="mood === 'info'">
          <!-- the one who knows: round glasses over the "< >" eyes -->
          <polyline points="446,556 400,596 446,636" stroke-width="44" />
          <polyline points="578,556 624,596 578,636" stroke-width="44" />
          <circle cx="440" cy="598" r="82" stroke-width="26" />
          <circle cx="584" cy="598" r="82" stroke-width="26" />
          <path d="M522 592 Q512 578 502 592" stroke-width="22" />
          <path d="M358 584 L300 560" stroke-width="22" />
          <path d="M666 584 L724 560" stroke-width="22" />
        </template>
        <template v-else-if="mood === 'question'">
          <!-- puzzled: one brow up, one down -->
          <polyline points="446,548 392,596 446,644" />
          <polyline points="578,548 632,596 578,644" />
          <path d="M386 494 Q446 450 506 486" stroke-width="30" />
          <path d="M548 530 L626 538" stroke-width="30" />
        </template>
        <template v-else>
          <polyline points="446,548 392,596 446,644" />
          <polyline points="578,548 632,596 578,644" />
        </template>
      </g>

      <!-- nose and mouth -->
      <path fill="#3B33A8" stroke="#3B33A8" stroke-width="16" stroke-linejoin="round" d="M486 662 L538 662 L512 694 Z" />
      <g fill="none" stroke="#3B33A8" stroke-width="22" stroke-linecap="round">
        <path v-if="mood === 'success'" d="M440 704 Q512 776 584 704" />
        <path v-else-if="mood === 'error'" d="M452 748 Q512 700 572 748" />
        <circle v-else-if="mood === 'warning'" cx="512" cy="730" r="24" />
        <path v-else-if="mood === 'question'" d="M482 732 Q508 712 534 732 T586 732" />
        <path v-else-if="mood === 'info'" d="M458 716 Q512 760 566 716" />
        <path v-else d="M470 724 C 490 744, 504 744, 512 728 C 520 744, 534 744, 554 724" />
      </g>

      <!-- extras: blush, a tear -->
      <template v-if="mood === 'success'">
        <ellipse cx="372" cy="668" rx="38" ry="22" fill="#FF8FB1" opacity="0.55" />
        <ellipse cx="652" cy="668" rx="38" ry="22" fill="#FF8FB1" opacity="0.55" />
      </template>
      <!-- a sweat drop at the temple -->
      <path v-if="mood === 'warning'" fill="#7CC9FF" stroke="#FFFFFF" stroke-width="8" d="M716 462 C 744 506, 750 530, 732 548 C 714 566, 686 552, 688 528 C 690 506, 704 484, 716 462 Z" />
      <path v-if="mood === 'error'" fill="#7CC9FF" stroke="#FFFFFF" stroke-width="8" d="M648 652 C 678 698, 684 724, 664 742 C 644 760, 614 744, 616 718 C 618 696, 634 674, 648 652 Z" />
    </g>

    <!-- badges and sparkles outside the head -->
    <g v-if="mood === 'success'" fill="#FFD75E">
      <use href="#cm-star" transform="translate(150 182) scale(1.05)" />
      <use href="#cm-star" transform="translate(888 792) scale(0.62)" />
      <use href="#cm-star" transform="translate(262 52) scale(0.38)" />
    </g>
    <g v-else-if="mood === 'warning'">
      <!-- a rounded triangle: the amber fill with a thick round-joined stroke, white ring first -->
      <path d="M800 548 L1000 920 L600 920 Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="150" stroke-linejoin="round" />
      <path d="M800 548 L1000 920 L600 920 Z" fill="#F5B01B" stroke="#F5B01B" stroke-width="80" stroke-linejoin="round" />
      <path d="M800 672 L800 806" fill="none" stroke="#3B2A00" stroke-width="56" stroke-linecap="round" />
      <circle cx="800" cy="884" r="32" fill="#3B2A00" />
    </g>
    <g v-else-if="mood === 'info'">
      <circle cx="790" cy="780" r="210" fill="#2FA8E6" stroke="#FFFFFF" stroke-width="34" />
      <circle cx="790" cy="672" r="38" fill="#FFFFFF" />
      <path d="M790 752 L790 890" fill="none" stroke="#FFFFFF" stroke-width="64" stroke-linecap="round" />
    </g>
    <g v-else-if="mood === 'question'">
      <!-- a speech bubble with its tail towards the cat -->
      <path d="M690 570 H890 A100 100 0 0 1 990 670 V870 A100 100 0 0 1 890 970 H690 A100 100 0 0 1 590 870 V760 L520 700 L590 690 V670 A100 100 0 0 1 690 570 Z" fill="#6D5DF6" stroke="#FFFFFF" stroke-width="34" stroke-linejoin="round" />
      <path d="M730 710 Q790 640 850 710 Q850 760 790 776 L790 808" fill="none" stroke="#FFFFFF" stroke-width="54" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="790" cy="880" r="32" fill="#FFFFFF" />
    </g>
  </svg>
</template>
