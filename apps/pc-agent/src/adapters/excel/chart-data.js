const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code});};
const columnIndex=name=>[...name].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
const columnName=index=>{let n=index+1,result='';while(n){result=String.fromCharCode(65+(n-1)%26)+result;n=Math.floor((n-1)/26);}return result;};
const cell=(columns,rows,row,column)=>row===1?columns[column]:Array.isArray(rows[row-2])?rows[row-2][column]:rows[row-2]?.[columns[column]];
const plain=value=>typeof value==='string'||typeof value==='number'&&Number.isFinite(value);
/** Range includes one header row, one category column and all remaining numeric series. */
export function workbookChartData(chart,columns,rows){
 if(!chart||typeof chart!=='object'||Array.isArray(chart))fail('B_WORKBOOK_CHART_INVALID');
 const type=String(chart.type??'bar').toLowerCase();
 if(!['bar','line','pie'].includes(type))fail('B_WORKBOOK_CHART_TYPE_UNSUPPORTED','unsupported-chart-type:'+type);
 const range=chart.range??`A1:${columnName(columns.length-1)}${rows.length+1}`;
 const match=typeof range==='string'&&/^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6}):\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/iu.exec(range);
 if(!match)fail('B_WORKBOOK_CHART_RANGE_INVALID');
 const startColumn=columnIndex(match[1].toUpperCase()),endColumn=columnIndex(match[3].toUpperCase()),startRow=Number(match[2]),endRow=Number(match[4]);
 if(startColumn<0||endColumn>=columns.length||endColumn<=startColumn||startRow>=endRow||endRow>rows.length+1)fail('B_WORKBOOK_CHART_RANGE_INVALID');
 if(type==='pie'&&endColumn-startColumn!==1)fail('B_WORKBOOK_CHART_PIE_SERIES_INVALID');
 if(chart.aggregation!==undefined&&chart.aggregation!=='count')fail('B_WORKBOOK_CHART_AGGREGATION_INVALID');
 const title=chart.title??'Chart';
 if(typeof title!=='string'||!title.trim()||title.length>200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(title))fail('B_WORKBOOK_CHART_TITLE_INVALID');
 if(chart.aggregation==='count'){
  if(endColumn-startColumn!==1)fail('B_WORKBOOK_CHART_COUNT_SERIES_INVALID');
  const counts=new Map();
  for(let row=startRow+1;row<=endRow;row++){
   const value=cell(columns,rows,row,endColumn);
   if(!plain(value)||!String(value).trim())fail('B_WORKBOOK_CHART_CATEGORY_INVALID');
   const label=String(value);counts.set(label,(counts.get(label)??0)+1);
  }
  return {type,title,range:`${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`,aggregation:'count',categoryColumn:'A',firstDataRow:2,lastDataRow:counts.size+1,categories:[...counts.keys()],series:[{name:'건수',column:'B',values:[...counts.values()]}]};
 }
 const categories=[];
 for(let row=startRow+1;row<=endRow;row++){
  const value=cell(columns,rows,row,startColumn);
  if(!plain(value))fail('B_WORKBOOK_CHART_CATEGORY_INVALID');
  categories.push(String(value));
 }
 const series=[];
 for(let column=startColumn+1;column<=endColumn;column++){
  const header=cell(columns,rows,startRow,column);
  if(!plain(header)||!String(header).trim())fail('B_WORKBOOK_CHART_HEADER_INVALID');
  const values=[];
  for(let row=startRow+1;row<=endRow;row++){
   const value=cell(columns,rows,row,column);
   if(typeof value!=='number'||!Number.isFinite(value))fail('B_WORKBOOK_CHART_NUMERIC_VALUES_REQUIRED');
   if(type==='pie'&&value<0)fail('B_WORKBOOK_CHART_PIE_NEGATIVE_VALUE');
   values.push(value);
  }
  series.push({name:String(header),column:columnName(column),values});
 }
 return {type,title,range:`${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`,categoryColumn:columnName(startColumn),firstDataRow:startRow+1,lastDataRow:endRow,categories,series};
}
export function normalizeWorkbookCharts(charts,columns,rows){
 if(!Array.isArray(charts))fail('B_WORKBOOK_CHARTS_ARRAY_REQUIRED');
 if(charts.length>3)fail('B_WORKBOOK_CHART_COUNT_EXCEEDED');
 return charts.map((chart,index)=>{
  if(!chart||typeof chart!=='object'||Array.isArray(chart))fail('B_WORKBOOK_CHART_INVALID');
  if(Object.keys(chart).some(key=>!['chartId','type','title','range','aggregation'].includes(key)))fail('B_WORKBOOK_CHART_OPTION_UNSUPPORTED');
  const data=workbookChartData({...chart,title:chart?.title??`Chart ${index+1}`},columns,rows);
  return {chartId:chart.chartId??`chart_${index+1}`,type:data.type,title:data.title,range:data.range,...(data.aggregation?{aggregation:data.aggregation}:{})};
 });
}
