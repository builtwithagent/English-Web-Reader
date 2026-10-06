import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_BLOCKS, MAX_BLOCK_CHARS } from './translate.constants';

/**
 * `/api/translate` 的入参（技术方案 5.2）。
 *
 * 校验策略上有一处**刻意的松紧不一**：
 * - `id` / `text` / `blocks` 校验从严 —— 它们错了就是调用方写错了，必须挡在门外；
 * - `targetLang` 只校验"是个字符串"，值非法交给 `normalizeTargetLang` 回落到默认。
 *   原因是技术方案 5.2 明确要求"缺省或不合法时回落到 zh-Hans，不报错"：
 *   一个存坏的偏好值不该让整篇文章翻不出来。
 */

export class TranslateBlockDto {
  /**
   * 块 id。**这是前后端的唯一锚点** —— 译文靠它回填到对应的原文格子里。
   * 它必须原样回传，服务端不做任何重排。
   */
  @IsInt({ message: 'id 必须是整数' })
  @Min(0, { message: 'id 不能为负' })
  id!: number;

  /**
   * 待翻译原文。
   *
   * 空串是允许的（`@IsNotEmpty` 没加），因为上层可能把整篇文章的块一股脑发过来，
   * 里面混着几张图片块的空文本很正常。**过短/无字母的块会在 Service 里被跳过**，
   * 在这里拦掉反而要多写一套前端预过滤逻辑，两边容易不一致。
   */
  @IsString()
  @MaxLength(MAX_BLOCK_CHARS, { message: `单块文本不能超过 ${MAX_BLOCK_CHARS} 字符` })
  text!: string;
}

export class TranslateRequestDto {
  /**
   * 原文地址。当前版本**不落缓存**，这个字段只为两点保留：
   * 1. 稳定契约 —— 前端不用等到有缓存那天再改请求体；
   * 2. 日志里能看出是哪个页面在烧额度。
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  /** 译文语言（BCP 47）。非法值不报错，回落 `zh-Hans` —— 见文件头说明 */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  targetLang?: string;

  @IsArray({ message: 'blocks 必须是数组' })
  @ArrayMinSize(1, { message: '至少要有一个待翻译块' })
  @ArrayMaxSize(MAX_BLOCKS, { message: `单次最多 ${MAX_BLOCKS} 个块` })
  @ValidateNested({ each: true })
  // `@Type` 是必需的：没有它，`@ValidateNested` 面对的是普通 object，
  // 里面那些 `@IsInt` / `@MaxLength` 一个都不会生效（坑很深，因为不报错，只是静默不校验）
  @Type(() => TranslateBlockDto)
  blocks!: TranslateBlockDto[];
}
