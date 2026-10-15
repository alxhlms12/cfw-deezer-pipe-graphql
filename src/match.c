#include <stdint.h>

/* Freestanding memcpy required by some clang optimization passes. */
void *memcpy(void *dst, const void *src, unsigned long n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  for (unsigned long i = 0; i < n; ++i) d[i] = s[i];
  return dst;
}

/* Small, bounded Levenshtein helper used to rank metadata search hits.
   This does not process or decrypt audio. Input strings are UTF-8 byte sequences. */
#define MAX_TEXT 512
static uint16_t row_a[MAX_TEXT + 1];
static uint16_t row_b[MAX_TEXT + 1];

__attribute__((export_name("input_offset")))
uint32_t input_offset(void) { return 16384; }

__attribute__((export_name("edit_distance")))
int32_t edit_distance(const uint8_t *a, int32_t alen, const uint8_t *b, int32_t blen) {
  if (!a || !b || alen < 0 || blen < 0 || alen > MAX_TEXT || blen > MAX_TEXT) return -1;
  if (alen > blen) {
    const uint8_t *p = a; a = b; b = p;
    int32_t t = alen; alen = blen; blen = t;
  }
  for (int32_t i = 0; i <= alen; i++) row_a[i] = (uint16_t)i;
  for (int32_t j = 1; j <= blen; j++) {
    row_b[0] = (uint16_t)j;
    for (int32_t i = 1; i <= alen; i++) {
      uint16_t substitution = (uint16_t)(row_a[i - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
      uint16_t deletion = (uint16_t)(row_a[i] + 1);
      uint16_t insertion = (uint16_t)(row_b[i - 1] + 1);
      uint16_t best = substitution < deletion ? substitution : deletion;
      row_b[i] = best < insertion ? best : insertion;
    }
    for (int32_t i = 0; i <= alen; i++) row_a[i] = row_b[i];
  }
  return row_a[alen];
}
