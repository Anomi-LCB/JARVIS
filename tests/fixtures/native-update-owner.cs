public static class Runner {
 public static void Main(string[] args) {
  var type=System.Reflection.Assembly.LoadFrom(args[0]).GetType("JarvisCoreRuntimeHost");
  var host=System.Activator.CreateInstance(type);
  var flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance;
  try {
   type.GetMethod("OnStart",flags).Invoke(host,new object[]{new string[0]});
   System.IO.File.WriteAllText(args[1],"ready");
   while(!System.IO.File.Exists(args[2]))System.Threading.Thread.Sleep(50);
  } finally {type.GetMethod("OnStop",flags).Invoke(host,null);}
 }
}
