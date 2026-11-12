package ke.co.lookmedia.riders;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-specific plugin: background GPS through a foreground service (see TrackerService).
        registerPlugin(RiderTrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
