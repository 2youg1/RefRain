import type { JSX } from "solid-js";

/**
 * 改排版的时候，作者看得见自己的字。
 *
 * 设置页独占 Stage（Plan P3），手稿被完全盖住——字距、词距、共享汉字优先级这类
 * 改动不看真实字形无法判断，而作者此刻恰恰看不到稿子。
 *
 * 这里刻意不重算任何排版值：`applyTypography` 已经把一整份 Config 投影成
 * documentElement 上的 CSS 变量，预览段读的是同一批变量，因此它显示的就是手稿
 * 将要显示的。另写一份映射会立刻产生第二个排版权威，而作者会更信任眼前这一份。
 *
 * 例文含中日西混排与一段引文，因为三槽字体与共享汉字优先级只有在混排里才看得出来。
 */
const SPECIMEN = [
  "写作是把尚未成形的东西按住，让它在纸面上停留得够久，久到可以被看清。",
  "推敲の余地は、書いた本人にしか見えない。The quick brown fox jumps over the lazy dog.",
] as const;

const QUOTE = "文章千古事，得失寸心知。";

export function TypographySpecimen(): JSX.Element {
  return (
    <section class="type-specimen" aria-label="排版预览">
      <div class="specimen-page">
        {SPECIMEN.map((line) => (
          <p class="specimen-line">{line}</p>
        ))}
        <blockquote class="specimen-quote">{QUOTE}</blockquote>
      </div>
    </section>
  );
}
