/**
 * Threshold for perceptual (Hamming) image-hash similarity above which two
 * posts are considered duplicates.
 *
 * Single source of truth shared by the parser, the observatory and the
 * user-post moderation flow. `DeduplicationService.calculateHashDistance`
 * returns a `0..1` similarity; a random pair of 256-bit hashes shares ~0.5 of
 * its bits, so a 0.5 cutoff drops unrelated posts with single-tone backgrounds.
 * 0.85 keeps real duplicates while ignoring that false-positive band.
 */
export const PUBLISHED_DUPLICATE_SIMILARITY = 0.85;
