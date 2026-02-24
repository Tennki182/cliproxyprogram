/**
 * Simple Chinese character to Pinyin converter
 * Used for normalizing function names to be compatible with Gemini API
 * 
 * Gemini API requirements for function names:
 * - Must start with a letter or underscore
 * - Can only contain: a-z, A-Z, 0-9, _, ., -
 * - Maximum 64 characters
 */

// LRU cache for pinyin conversion
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

// Pinyin cache (max 1000 entries)
const pinyinCache = new LRUCache<string, string>(1000);

// Common Chinese characters to pinyin mapping (deduplicated)
// Generated from most frequently used Chinese characters
const charToPinyin: Record<string, string> = {
  '的': 'de', '是': 'shi', '在': 'zai', '有': 'you', '我': 'wo', '他': 'ta', '她': 'ta', '它': 'ta',
  '们': 'men', '这': 'zhe', '那': 'na', '个': 'ge', '不': 'bu', '会': 'hui', '能': 'neng', '可': 'ke',
  '以': 'yi', '了': 'le', '和': 'he', '与': 'yu', '或': 'huo', '为': 'wei', '中': 'zhong', '上': 'shang',
  '下': 'xia', '前': 'qian', '后': 'hou', '左': 'zuo', '右': 'you', '内': 'nei', '外': 'wai', '里': 'li',
  '间': 'jian', '方': 'fang', '地': 'di', '得': 'de', '着': 'zhe', '过': 'guo', '来': 'lai', '去': 'qu',
  '到': 'dao', '从': 'cong', '向': 'xiang', '往': 'wang', '对': 'dui', '将': 'jiang', '被': 'bei', '把': 'ba',
  '让': 'rang', '给': 'gei', '使': 'shi', '令': 'ling', '叫': 'jiao', '请': 'qing', '求': 'qiu', '问': 'wen',
  '说': 'shuo', '想': 'xiang', '看': 'kan', '听': 'ting', '做': 'zuo', '作': 'zuo', '工': 'gong', '事': 'shi',
  '情': 'qing', '物': 'wu', '人': 'ren', '家': 'jia', '国': 'guo', '社': 'she', '时': 'shi', '分': 'fen',
  '秒': 'miao', '天': 'tian', '月': 'yue', '年': 'nian', '日': 'ri', '今': 'jin', '明': 'ming', '昨': 'zuo',
  '查': 'cha', '询': 'xun', '搜': 'sou', '索': 'suo', '获': 'huo', '取': 'qu', '提': 'ti', '交': 'jiao',
  '发': 'fa', '送': 'song', '接': 'jie', '收': 'shou', '读': 'du', '写': 'xie', '编': 'bian', '译': 'yi',
  '运': 'yun', '行': 'xing', '执': 'zhi', '调': 'diao', '用': 'yong', '创': 'chuang', '建': 'jian', '删': 'shan',
  '除': 'chu', '修': 'xiu', '改': 'gai', '更': 'geng', '新': 'xin', '增': 'zeng', '加': 'jia', '减': 'jian',
  '少': 'shao', '乘': 'cheng', '计': 'ji', '算': 'suan', '析': 'xi', '解': 'jie', '显': 'xian', '示': 'shi',
  '打': 'da', '印': 'yin', '输': 'shu', '入': 'ru', '导': 'dao', '航': 'hang', '跳': 'tiao', '转': 'zhuan',
  '返': 'fan', '回': 'hui', '退': 'tui', '关': 'guan', '闭': 'bi', '开': 'kai', '启': 'qi', '动': 'dong',
  '停': 'ting', '止': 'zhi', '暂': 'zan', '继': 'ji', '续': 'xu', '恢': 'hui', '复': 'fu', '重': 'zhong',
  '刷': 'shua', '清': 'qing', '空': 'kong', '置': 'zhi', '初': 'chu', '始': 'shi', '化': 'hua', '配': 'pei',
  '设': 'she', '选': 'xuan', '择': 'ze', '切': 'qie', '换': 'huan', '替': 'ti', '变': 'bian', '成': 'cheng',
  '当': 'dang', '视': 'shi', '认': 'ren', '等': 'deng', '同': 'tong', '相': 'xiang', '类': 'lei', '似': 'si',
  '好': 'hao', '像': 'xiang', '仿': 'fang', '佛': 'fu', '乎': 'hu', '如': 'ru', '果': 'guo', '假': 'jia',
  '若': 'ruo', '要': 'yao', '只': 'zhi', '既': 'ji', '然': 'ran', '由': 'you', '于': 'yu', '因': 'yin',
  '原': 'yuan', '缘': 'yuan', '故': 'gu', '所': 'suo', '此': 'ci', '而': 'er', '乃': 'nai', '至': 'zhi',
  '甚': 'shen', '及': 'ji', '并': 'bing', '且': 'qie', '况': 'kuang', '再': 'zai', '另': 'ling', '之': 'zhi',
  '非': 'fei', '唯': 'wei', '惟': 'wei', '尽': 'jin', '管': 'guan', '虽': 'sui', '则': 'ze', '即': 'ji',
  '便': 'bian', '就': 'jiu', '哪': 'na', '怕': 'pa', '无': 'wu', '论': 'lun', '任': 'ren', '何': 'he',
  '每': 'mei', '次': 'ci', '旦': 'dan', '一': 'yi', '倘': 'tang', '万': 'wan', '些': 'xie', '点': 'dian',
  '某': 'mou', '什': 'shen', '么': 'me', '怎': 'zen', '样': 'yang', '种': 'zhong', '多': 'duo', '几': 'ji',
  '谁': 'shui', '位': 'wei', '处': 'chu', '儿': 'er', '久': 'jiu', '干': 'gan', '吗': 'ma', '呢': 'ne',
  '吧': 'ba', '啊': 'a', '哦': 'o', '嗯': 'en', '哎': 'ai', '哟': 'yo', '喂': 'wei', '嗨': 'hai',
  '哈': 'ha', '嘿': 'hei', '哼': 'heng', '呀': 'ya', '哇': 'wa', '啦': 'la', '住': 'zhu', '领': 'ling',
  '引': 'yin', '指': 'zhi', '表': 'biao', '现': 'xian', '体': 'ti', '呈': 'cheng', '出': 'chu', '涌': 'yong',
  '浮': 'fu', '冒': 'mao', '透': 'tou', '流': 'liu', '泄': 'xie', '散': 'san', '布': 'bu', '公': 'gong',
  '告': 'gao', '称': 'cheng', '声': 'sheng', '证': 'zheng', '阐': 'chan', '释': 'shi', '注': 'zhu', '批': 'pi',
  '附': 'fu', '备': 'bei', '补': 'bu', '脚': 'jiao', '参': 'can', '考': 'kao', '文': 'wen', '献': 'xian',
  '资': 'zi', '料': 'liao', '材': 'cai', '数': 'shu', '据': 'ju', '信': 'xin', '息': 'xi', '消': 'xiao',
  '报': 'bao', '闻': 'wen', '讯': 'xun', '态': 'tai', '状': 'zhuang', '形': 'xing', '势': 'shi', '局': 'ju',
  '趋': 'qu', '走': 'zou', '程': 'cheng', '序': 'xu', '步': 'bu', '骤': 'zhou', '环': 'huan', '节': 'jie',
  '阶': 'jie', '段': 'duan', '期': 'qi', '代': 'dai', '岁': 'sui', '子': 'zi', '光': 'guang', '阴': 'yin',
  '气': 'qi', '候': 'hou', '季': 'ji', '春': 'chun', '夏': 'xia', '秋': 'qiu', '冬': 'dong', '朝': 'chao',
  '夕': 'xi', '晨': 'chen', '昏': 'hun', '昼': 'zhou', '夜': 'ye', '早': 'zao', '晚': 'wan', '午': 'wu',
  '半': 'ban', '深': 'shen', '凌': 'ling', '拂': 'fu', '晓': 'xiao', '黎': 'li', '傍': 'bang', '黄': 'huang',
  '暮': 'mu', '阳': 'yang', '残': 'can', '斜': 'xie', '余': 'yu', '晖': 'hui', '曙': 'shu', '曦': 'xi',
  '霞': 'xia', '虹': 'hong', '霓': 'ni', '霁': 'ji', '彩': 'cai', '色': 'se', '颜': 'yan', '泽': 'ze',
  '亮': 'liang', '度': 'du', '暗': 'an', '淡': 'dan', '浓': 'nong', '厚': 'hou', '薄': 'bao', '轻': 'qing',
  '肥': 'fei', '瘦': 'shou', '胖': 'pang', '强': 'qiang', '弱': 'ruo', '快': 'kuai', '慢': 'man', '急': 'ji',
  '缓': 'huan', '忙': 'mang', '闲': 'xian', '劳': 'lao', '逸': 'yi', '静': 'jing', '闹': 'nao', '喧': 'xuan',
  '嚣': 'xiao', '嘈': 'cao', '杂': 'za', '寂': 'ji', '安': 'an', '宁': 'ning', '平': 'ping', '冷': 'leng',
  '镇': 'zhen', '沉': 'chen', '容': 'rong', '定': 'ding', '泰': 'tai', '悠': 'you', '怡': 'yi', '欣': 'xin',
  '豁': 'huo', '恍': 'huang', '茫': 'mang', '惘': 'wang', '怅': 'chang', '黯': 'an', '凄': 'qi', '惨': 'can',
  '凛': 'lin', '肃': 'su', '俨': 'yan', '翩': 'pian', '飘': 'piao', '悄': 'qiao', '蓦': 'mo', '突': 'tu',
  '忽': 'hu', '猝': 'cu', '陡': 'dou', '枉': 'wang', '必': 'bi', '竟': 'jing', '居': 'ju', '油': 'you',
  '盎': 'ang', '兴': 'xing', '味': 'wei', '耐': 'nai', '寻': 'xun', '穷': 'qiong', '意': 'yi', '犹': 'you',
  '未': 'wei', '思': 'si', '议': 'yi', '难': 'nan', '匪': 'fei', '夷': 'yi', '梦': 'meng', '吃': 'chi',
  '惊': 'jing', '跌': 'die', '眼': 'yan', '镜': 'jing', '瞪': 'deng', '口': 'kou', '呆': 'dai', '张': 'zhang',
  '舌': 'she', '哑': 'ya', '言': 'yan', '话': 'hua', '力': 'li', '反': 'fan', '抗': 'kang', '策': 'ce',
  '筹': 'chou', '莫': 'mo', '展': 'zhan', '纳': 'na', '爱': 'ai', '助': 'zhu', '望': 'wang', '洋': 'yang',
  '叹': 'tan', '尘': 'chen', '背': 'bei', '鞭': 'bian', '长': 'chang', '心': 'xin', '足': 'zu', '驾': 'jia',
  '熟': 'shu', '游': 'you', '刃': 'ren', '应': 'ying', '鱼': 'yu', '水': 'shui', '渠': 'qu', '瓜': 'gua',
  '蒂': 'di', '落': 'luo', '顺': 'shun', '理': 'li', '章': 'zhang', '其': 'qi', '自': 'zi', '遇': 'yu',
  '逆': 'ni', '受': 'shou', '忍': 'ren', '吞': 'tun', '曲': 'qu', '全': 'quan', '海': 'hai', '阔': 'kuo',
  '浪': 'lang', '舟': 'zhou', '矢': 'shi', '遗': 'yi', '忘': 'wang', '师': 'shi', '鉴': 'jian', '戒': 'jie',
  '钟': 'zhong', '鸣': 'ming', '患': 'huan', '雨': 'yu', '绸': 'chou', '缪': 'mou', '蛇': 'she', '漏': 'lou',
  '风': 'feng', '密': 'mi', '露': 'lu', '合': 'he', '勾': 'gou', '结': 'jie', '狼': 'lang', '狈': 'bei',
  '沆': 'hang', '瀣': 'xie', '狐': 'hu', '朋': 'peng', '狗': 'gou', '友': 'you', '肉': 'rou', '猪': 'zhu',
  '丘': 'qiu', '貉': 'he', '路': 'lu', '货': 'huo', '模': 'mu', '辙': 'zhe', '异': 'yi', '伯': 'bo',
  '仲': 'zhong', '均': 'jun', '敌': 'di', '棋': 'qi', '逢': 'feng', '良': 'liang', '才': 'cai', '龙': 'long',
  '虎': 'hu', '斗': 'dou', '鹬': 'yu', '蚌': 'bang', '渔': 'yu', '翁': 'weng', '坐': 'zuo', '山': 'shan',
  '费': 'fei', '吹': 'chui', '灰': 'hui', '擒': 'qin', '探': 'tan', '囊': 'nang', '瓮': 'weng', '捉': 'zhuo',
  '鳖': 'bie', '稳': 'wen', '操': 'cao', '胜': 'sheng', '券': 'quan', '握': 'wo', '志': 'zhi', '胸': 'xiong',
  '竹': 'zhu', '枕': 'zhen', '忧': 'you', '恙': 'yang', '盛': 'sheng', '世': 'shi', '民': 'min', '康': 'kang',
  '阜': 'fu', '丰': 'feng', '衣': 'yi', '食': 'shi', '业': 'ye', '小': 'xiao', '满': 'man', '幸': 'xing',
  '福': 'fu', '甜': 'tian', '蜜': 'mi', '温': 'wen', '馨': 'xin', '睦': 'mu', '洽': 'qia', '谐': 'xie',
  '美': 'mei', '优': 'you', '秀': 'xiu', '卓': 'zhuo', '越': 'yue', '杰': 'jie', '精': 'jing', '致': 'zhi',
  '完': 'wan', '善': 'shan', '周': 'zhou', '详': 'xiang', '具': 'ju', '准': 'zhun', '确': 'que', '恰': 'qia',
  '妥': 'tuo', '适': 'shi', '宜': 'yi', '刚': 'gang', '巧': 'qiao', '偏': 'pian', '碰': 'peng', '赶': 'gan',
  '凑': 'cou', '妙': 'miao', '独': 'du', '偶': 'ou', '影': 'ying', '离': 'li', '双': 'shuang', '搭': 'da',
  '组': 'zu', '融': 'rong', '整': 'zheng', '综': 'zong', '协': 'xie', '剂': 'ji', '排': 'pai', '制': 'zhi',
  '订': 'ding', '拟': 'ni', '草': 'cao', '起': 'qi', '撰': 'zhuan', '辑': 'ji', '润': 'run', '添': 'tian',
  '扩': 'kuo', '充': 'chong', '延': 'yan', '伸': 'shen', '推': 'tui', '迟': 'chi', '拖': 'tuo', '耽': 'dan',
  '搁': 'ge', '误': 'wu', '顿': 'dun', '滞': 'zhi', '歇': 'xie', '阻': 'zu', '割': 'ge', '截': 'jie',
  '破': 'po', '冲': 'chong', '攻': 'gong', '击': 'ji', '坏': 'huai', '损': 'sun', '毁': 'hui', '摧': 'cui',
  '销': 'xiao', '烧': 'shao', '焚': 'fen', '灭': 'mie', '歼': 'jian', '剿': 'jiao', '扑': 'pu', '熄': 'xi',
  '覆': 'fu', '亡': 'wang', '死': 'si', '毙': 'bi', '命': 'ming', '丧': 'sang', '伤': 'shang', '负': 'fu',
  '刺': 'ci', '划': 'hua', '擦': 'ca', '撞': 'zhuang', '摔': 'shuai', '扭': 'niu', '挫': 'cuo', '拉': 'la',
  '扯': 'che', '撕': 'si', '裂': 'lie', '碎': 'sui', '决': 'jue', '绝': 'jue', '断': 'duan', '坚': 'jian',
  '毅': 'yi', '纸': 'zhi', '谈': 'tan', '兵': 'bing', '华': 'hua', '虚': 'xu', '伪': 'wei', '装': 'zhuang',
  '弄': 'nong', '滥': 'lan', '竽': 'yu', '蒙': 'meng', '混': 'hun', '欺': 'qi', '瞒': 'man', '掩': 'yan',
  '耳': 'er', '盗': 'dao', '铃': 'ling', '欲': 'yu', '盖': 'gai', '弥': 'mi', '彰': 'zhang', '画': 'hua',
  '生': 'sheng', '枝': 'zhi', '横': 'heng', '惹': 're', '招': 'zhao', '蜚': 'fei', '语': 'yu', '惑': 'huo',
  '众': 'zhong', '妖': 'yao', '蠱': 'gu', '蔽': 'bi', '骗': 'pian', '诈': 'zha', '拐': 'guai', '诓': 'kuang',
  '哄': 'hong', '诱': 'you', '劝': 'quan', '吸': 'xi', '揽': 'lan', '募': 'mu', '征': 'zheng', '集': 'ji',
  '召': 'zhao', '举': 'ju', '办': 'ban', '主': 'zhu', '承': 'cheng', '实': 'shi', '施': 'shi', '履': 'lv',
  '进': 'jin', '促': 'cu', '速': 'su', '升': 'sheng', '益': 'yi', '终': 'zhong',

};

/**
 * Check if a character is Chinese
 * Includes CJK Unified Ideographs and Extension A
 */
function isChineseChar(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  // CJK Unified Ideographs: 4E00-9FFF
  // CJK Unified Ideographs Extension A: 3400-4DBF
  // CJK Unified Ideographs Extension B: 20000-2A6DF (surrogate pairs)
  return (code >= 0x4E00 && code <= 0x9FFF) || 
         (code >= 0x3400 && code <= 0x4DBF);
}

/**
 * Check if a string contains Chinese characters
 */
function containsChinese(text: string): boolean {
  for (const char of text) {
    if (isChineseChar(char)) return true;
  }
  return false;
}

/**
 * Convert a Chinese character to pinyin
 * Falls back to underscore for unknown characters
 */
function charToPinyinSingle(char: string): string {
  if (!isChineseChar(char)) {
    return char;
  }
  return charToPinyin[char] || '_';
}

/**
 * Convert Chinese text to pinyin
 * Uses LRU cache for performance
 * @param text The text to convert
 * @returns Pinyin representation
 */
export function toPinyin(text: string): string {
  if (!text) return '';
  
  // Check cache first
  const cached = pinyinCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  
  // Quick check if contains Chinese
  if (!containsChinese(text)) {
    pinyinCache.set(text, text);
    return text;
  }
  
  let result = '';
  for (const char of text) {
    result += charToPinyinSingle(char);
  }
  
  // Cache result
  pinyinCache.set(text, result);
  return result;
}

/**
 * Normalize a function name to be compatible with Gemini API
 * 
 * Rules:
 * 1. Convert Chinese characters to pinyin
 * 2. Replace invalid characters with underscores
 * 3. Ensure it starts with a letter or underscore
 * 4. Truncate to 64 characters
 * 5. Ensure it's not empty
 * 
 * Valid characters: a-z, A-Z, 0-9, _, ., -
 * 
 * @param name The original function name
 * @returns Normalized function name
 */
export function normalizeFunctionName(name: string): string {
  if (!name || typeof name !== 'string') {
    return '_unnamed_function';
  }

  // Step 1: Convert Chinese characters to pinyin
  let normalized = toPinyin(name);

  // Step 2: Replace invalid characters with underscores
  // Valid characters: a-z, A-Z, 0-9, _, ., -
  normalized = normalized.replace(/[^a-zA-Z0-9_.\-]/g, '_');

  // Step 3: Ensure it starts with a letter or underscore
  if (normalized.length > 0 && !/^[a-zA-Z_]/.test(normalized)) {
    normalized = '_' + normalized;
  }

  // Step 4: Truncate to 64 characters
  if (normalized.length > 64) {
    normalized = normalized.substring(0, 64);
  }

  // Step 5: Ensure it's not empty
  if (!normalized) {
    normalized = '_unnamed_function';
  }

  return normalized;
}
